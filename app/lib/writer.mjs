// 서브시스템 작성자
//  - 에이전트 방식(Codex·Claude CLI): 킷 지시서 파일을 주고 모델이 직접 YAML을 쓰고 swd validate로 고친다.
//  - 텍스트 방식(API 키 등): 산출물 하나씩 인라인 지시서 → 파일 블록 응답 → 앱이 저장·검증 → 오류를 돌려주며 고친다.
import fs from 'node:fs';
import path from 'node:path';
import { lib, loadModel, validate, parseYaml, readYamlFile, writeYamlFile, KIT_SKILL } from './engine.mjs';
import { parseBlocks } from './blocks.mjs';

export const WRITER_SYSTEM = [
  '너는 「CBD SW개발 표준 산출물 관리 가이드」 양식의 산출물 데이터(YAML)를 쓰는 작성자다.',
  '작성 지시서만 따른다. 입력 근거가 있는 값만 사실(origin: fact)로 쓰고, 가이드상 도출하는 설계는 origin: ai로 표시한다.',
  '근거 없는 이름·수치·일정·제품명을 만들지 않는다. 근거가 부족한 산출물은 만들지 않고 생략 블록을 낸다.',
  '출력은 지시서 6장의 블록(=== FILE / === SKIP … === END)만 쓴다.',
].join('\n');

const MAX_FIX_ROUNDS = 3;

// 다른 서브시스템이 아직 쓰지 않은 ID 참조는 병렬 작성 중 정상 → 고칠 오류에서 뺀다(같은 서브시스템 ID가 없으면 진짜 오류)
function isCrossRefPending(e, sub) {
  const m = /참조 대상 없음 '([^']+)'/.exec(e.message);
  if (!m) return false;
  const id = m[1];
  return !(id.includes(`-${sub}-`) || id.includes(`_${sub}_`));
}

function errorsFor(res, sub, code) {
  return res.errors.filter((e) => (!e.sub || e.sub === sub) && (!code || !e.code || e.code === code) && !isCrossRefPending(e, sub));
}

function fmtIssues(list) {
  return list.slice(0, 40).map((e) => `- ${[e.sub, e.code, e.id, e.field].filter(Boolean).join(' · ')} — ${e.message}`).join('\n');
}

// ── 텍스트 방식 ───────────────────────────────────────────
export async function writeSubChat(ctx, provider, { stage, sub, docs, log, signal, logFile, change, initialFeedback = {} }) {
  const { buildPrompt } = await lib('prompt.mjs');
  const result = { written: [], skipped: [], errors: [] };
  const { preskip } = await lib('ops.mjs');
  const { planDocs } = await lib('prompt.mjs');
  result.deferred = [];
  for (const code of docs) {
    const m0 = await loadModel(ctx);
    // 공용 데이터베이스(SYSTEM D9)는 마스터가 정의한다 — 이미 있으면 다시 쓰지 않는다
    if (sub === 'SYSTEM' && code === 'D9' && (m0.get('SYSTEM', 'D9').databases || []).length) { log('SYSTEM D9 공용 데이터베이스는 마스터 정의 유지'); continue; }
    // 선행 산출물이 같은 단계 계획에 있는데 아직 없으면(작성 실패 등) 보류 — 나중에 누락 재요청에서 다시 쓴다
    const reqs = ctx.schemas.byCode[code]?.requires || [];
    const plan = change ? [] : planDocs(ctx, stage, sub, m0);
    const pending = reqs.filter((r) => plan.includes(r) && !m0.has(sub, r));
    if (pending.length) { result.deferred.push(code); log(`${sub} ${code} 보류 — 선행 ${pending.join(', ')} 미작성`); continue; }
    let feedback = initialFeedback[code] || ''; // 병합 검증에서 넘어온 오류가 있으면 첫 요청부터 함께 보낸다
    // 같은 단계에서 앞 산출물이 생략됐으면(예: D8 → D9) 가이드 선행 산출물 기준으로 이 산출물도 생략 기록
    if (!change && sub !== 'SYSTEM') {
      const added = await preskip(ctx, await loadModel(ctx), { stage, subs: [sub] });
      if (added.includes(`${sub}:${code}`)) { result.skipped.push(code); log(`${sub} ${code} 생략 — 선행 산출물 없음`); continue; }
    }
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      if (signal?.aborted) throw new Error('중지됨');
      const model = await loadModel(ctx);
      if (model.isSkipped(sub, code) && !change) { result.skipped.push(code); break; }
      let prompt = await buildPrompt(ctx, model, { stage, sub, docs: [code], inline: true, change });
      if (feedback) prompt += `\n\n## 부록 D. 검증 오류 — 모두 고쳐 파일 전체를 다시 출력하라\n\n${feedback}\n`;
      log(`${sub} ${code} ${round ? `수정 ${round}회차` : '작성'} 요청`);
      let text;
      try {
        ({ text } = await provider.complete({ system: WRITER_SYSTEM, prompt, signal, cwd: ctx.root, logFile }));
      } catch (e) {
        if (e.truncated && round < MAX_FIX_ROUNDS) { feedback = '응답이 출력 한도에서 잘렸다. 설명을 줄이고 YAML만 간결하게 다시 출력하라.'; continue; }
        throw e;
      }
      const applied = await applyBlocks(ctx, sub, [code], text);
      if (applied.problems.length) { feedback = applied.problems.join('\n'); if (round === MAX_FIX_ROUNDS) result.errors.push(`${code}: ${feedback}`); continue; }
      if (applied.skipped.includes(code)) { result.skipped.push(code); log(`${sub} ${code} 생략 — ${applied.skipReasons[code] || ''}`); break; }
      const res = await validate(ctx, await loadModel(ctx), { subs: [sub], codes: [code] });
      const errs = errorsFor(res, sub, code);
      if (!errs.length) { result.written.push(code); log(`${sub} ${code} 완료 (경고 ${res.warnings.length})`); break; }
      feedback = fmtIssues(errs);
      if (round === MAX_FIX_ROUNDS) { result.errors.push(`${code}: 검증 오류 ${errs.length}건 남음`); result.written.push(code); log(`${sub} ${code} 검증 오류 ${errs.length}건 남음`); }
    }
  }
  return result;
}

// 파일 블록 적용: 허용된 파일만 쓰고, 생략 블록은 _skip.yaml에 합친다
export async function applyBlocks(ctx, sub, allowedCodes, text) {
  const { modelFile, skipFile } = await lib('model.mjs');
  const blocks = parseBlocks(text);
  const out = { written: [], skipped: [], skipReasons: {}, problems: [] };
  if (!blocks.length) { out.problems.push('출력에 === FILE 또는 === SKIP 블록이 없다. 지시서 6장의 형식대로 출력하라.'); return out; }
  const rel = (f) => path.relative(ctx.root, f).replace(/\\/g, '/');
  const allowed = new Map(allowedCodes.map((c) => [rel(modelFile(ctx.p, sub, c)), c]));
  for (const b of blocks) {
    if (b.type === 'SKIP') {
      const code = b.target.toUpperCase();
      if (!allowedCodes.includes(code)) { out.problems.push(`생략 블록의 코드 ${code}는 이번 작성 대상이 아니다`); continue; }
      const existing = modelFile(ctx.p, sub, code);
      if (fs.existsSync(existing) && fs.readFileSync(existing, 'utf8').trim()) { out.problems.push(`${code}는 이미 작성된 산출물이라 생략할 수 없다. 부록 C의 현재 내용을 유지·보완해 파일 블록으로 출력하라.`); continue; }
      let info;
      try { info = (await parseYaml(b.body)) || {}; } catch (e) { out.problems.push(`생략 블록 YAML 오류: ${e.message.split('\n')[0]}`); continue; }
      if (!info.reason) { out.problems.push(`생략 블록 ${code}에 reason이 없다`); continue; }
      const sf = skipFile(ctx.p, sub);
      const cur = (await readYamlFile(sf, {})) || {};
      cur[code] = { reason: info.reason, needs: info.needs || '', sources: info.sources || [] };
      await writeYamlFile(sf, cur);
      const mf = modelFile(ctx.p, sub, code);
      out.skipped.push(code);
      out.skipReasons[code] = info.reason;
      continue;
    }
    const target = b.target.replace(/\\/g, '/').replace(/^\.\//, '');
    const code = allowed.get(target);
    if (!code) { out.problems.push(`허용되지 않은 파일: ${target} (쓸 수 있는 파일: ${[...allowed.keys()].join(', ')})`); continue; }
    try { await parseYaml(b.body); } catch (e) { out.problems.push(`${target} YAML 구문 오류(위치와 주변 줄):\n${e.message.split('\n').slice(0, 14).join('\n')}\n→ 해당 줄의 들여쓰기와 따옴표를 고치고, 콜론(:)·#이 든 문자열은 큰따옴표로 감싸라.`); continue; }
    const file = path.join(ctx.root, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, b.body, 'utf8');
    // 이전에 생략했던 산출물을 이번에 작성했으면 생략 기록을 지운다
    const sf = skipFile(ctx.p, sub);
    const cur = (await readYamlFile(sf, null));
    if (cur && cur[code]) { delete cur[code]; await writeYamlFile(sf, cur); }
    out.written.push(code);
  }
  return out;
}

// ── 에이전트 방식 ─────────────────────────────────────────
export async function writeSubAgent(ctx, provider, { stage, sub, promptFile, log, signal, logFile }) {
  log(`${sub} 에이전트 작성 시작`);
  const instruction = `작성 지시서 ${promptFile} 를 처음부터 끝까지 읽고 그대로 수행하라. 쓰기 허용 파일만 수정하고, 끝나면 지시서 7장 형식으로 보고하라.`;
  const r = await provider.runAgent({ cwd: ctx.root, instruction, signal, logFile });
  log(`${sub} 에이전트 작성 끝`);
  return { report: r.text };
}

export async function fixSubAgent(ctx, provider, { sub, promptFile, errors, signal, logFile, log }) {
  log(`${sub} 검증 오류 ${errors.length}건 수정 요청`);
  const instruction = [
    `작성 지시서 ${promptFile} 에 따라 작성한 파일에 아래 검증 오류가 있다. 지시서의 쓰기 허용 파일 안에서 모두 고치고, 지시서의 validate 명령으로 오류 0건을 확인하라.`,
    fmtIssues(errors),
  ].join('\n');
  const r = await provider.runAgent({ cwd: ctx.root, instruction, signal, logFile });
  return { report: r.text };
}

export { errorsFor, fmtIssues, KIT_SKILL };
