// 운영 명령: init · confirm · history · derive · scan-code · next-id · status
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './deps.mjs';
import { readYaml, writeYaml, paths, isoToday } from './project.mjs';
import { modelFile, isEmpty } from './model.mjs';
import { nextIds } from './ids.mjs';

export async function init(targetDir, { systemName, projectId } = {}) {
  const root = path.resolve(targetDir);
  const p = paths(root);
  for (const d of [p.root, p.model, p.output, p.inputs, p.prompts, p.diagrams,
    path.join(p.input, '회의록'), path.join(p.input, '아이디어'), path.join(p.input, '수정사항'), path.join(p.input, '참고문서')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  let created = false;
  if (!fs.existsSync(p.config)) {
    let tpl = fs.readFileSync(path.join(SKILL_DIR, 'templates', 'sw-config.template.yaml'), 'utf8');
    if (systemName) tpl = tpl.replace('system_name: ""', `system_name: "${systemName}"`);
    if (projectId) tpl = tpl.replace('id: PRJ ', `id: ${projectId} `);
    fs.writeFileSync(p.config, tpl, 'utf8');
    created = true;
  }
  const readme = path.join(p.input, '여기에_자료를_넣으세요.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '이 폴더에 산출물 작성의 근거 자료를 넣습니다. (txt, md, docx, hwp, hwpx, pdf)',
      '',
      '  회의록/    회의록 (착수·요구사항 협의·설계 검토 회의 등)',
      '  아이디어/  개인 아이디어·메모·구상',
      '  수정사항/  이미 작성된 산출물에 대한 수정·변경 요청',
      '  참고문서/  제안요청서(RFP)·과업지시서·제안서·관련 규정',
      '',
      '※ 보안: 입력 자료는 AI 서비스로 전송되어 처리됩니다. 발주처 보안 규정상 반출이 제한된 자료,',
      '   개인정보·비밀 등급 자료는 넣지 말거나 먼저 가려 주세요. (주민번호·전화·이메일·카드번호는 자동 마스킹)',
    ].join('\r\n'), 'utf8');
  }
  const gi = path.join(root, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.work/\ninput/\n', 'utf8');
  return { root, created };
}

// ── AI 제안 확인(승인) ───────────────────────────────────
export async function confirm(ctx, model, { subs, codes, ids = null, except = [] }) {
  let count = 0;
  const touch = (meta, idLabel) => {
    if (!meta || meta.confirmed) return;
    const isAi = meta.origin === 'ai' || (Array.isArray(meta.ai_fields) && meta.ai_fields.length);
    if (!isAi) return;
    if (ids && !ids.includes(idLabel)) return;
    if (except.includes(idLabel)) return;
    meta.confirmed = true;
    meta.confirmed_at = isoToday();
    count += 1;
  };
  for (const d of Object.values(model.docs)) {
    if (subs && !subs.includes(d.sub)) continue;
    if (codes && !codes.includes(d.code)) continue;
    let changed = false;
    const before = count;
    for (const [k, v] of Object.entries(d.data || {})) {
      if (Array.isArray(v)) v.forEach((it) => touch(it?._meta, it?.id || it?.term || it?.requirement_id || k));
      else if (k === 'sections' && v) Object.entries(v).forEach(([num, sec]) => touch(sec?._meta, num));
      else if (v && typeof v === 'object') touch(v._meta, k);
    }
    changed = count > before;
    if (changed) await writeYaml(d.file, d.data);
  }
  return count;
}

// ── 제·개정 이력 ────────────────────────────────────────
export async function addHistory(ctx, { docs, content, date, author, approver, version }) {
  const hist = (await readYaml(ctx.p.history, { entries: [] })) || { entries: [] };
  hist.entries = hist.entries || [];
  const entry = {
    date: date || isoToday(),
    docs,
    author: author ?? ctx.cfg.document?.author ?? '',
    approver: approver ?? ctx.cfg.document?.approver ?? '',
    content,
  };
  if (version) entry.version = version;
  hist.entries.push(entry);
  await writeYaml(ctx.p.history, hist);
  return entry;
}

// ── 결과서 뼈대 파생(현행화): D11→I2, D10→T1, D7→T2, T6→T7 ─
function mergeResults(fresh, old, fields) {
  if (!Array.isArray(fresh) || !Array.isArray(old)) return;
  for (const item of fresh) {
    const key = item?.id ?? item?.seq ?? item?.requirement_id;
    const prev = old.find((o) => (o?.id ?? o?.seq ?? o?.requirement_id) === key);
    if (!prev) continue;
    for (const [fname, f] of Object.entries(fields || {})) {
      if (!f || typeof f !== 'object') continue;
      if (f.result && prev[fname] !== undefined) item[fname] = prev[fname];
      if (f.type === 'object-list') mergeResults(item[fname], prev[fname], f.fields);
    }
    if (prev._meta?.result_sources) item._meta = { ...(item._meta || {}), result_sources: prev._meta.result_sources };
  }
}

export async function derive(ctx, model, { stage, subs }) {
  const pairs = stage === 'implementation' ? [['D11', 'I2']] : stage === 'test' ? [['D10', 'T1'], ['D7', 'T2'], ['T6', 'T7']] : [];
  const done = [];
  for (const [src, dst] of pairs) {
    const dstSchema = ctx.schemas.byCode[dst];
    for (const sub of model.subsOf(src)) {
      if (subs && !subs.includes(sub)) continue;
      const fresh = JSON.parse(JSON.stringify(model.get(sub, src)));
      const old = model.get(sub, dst);
      for (const [coll, espec] of Object.entries(dstSchema.entities || {})) mergeResults(fresh[coll], old[coll], espec.fields);
      await writeYaml(modelFile(ctx.p, sub, dst), fresh);
      done.push(`${sub}:${src}→${dst}`);
    }
  }
  return done;
}

// ── 선행 산출물 기준 자동 생략(가이드 작성 방법의 선행 산출물: schema requires / requires_reqs) ──
// 같은 단계에서 작성될 선행 산출물은 '있는 것'으로 보고, 선행 산출물이 생략되면 뒤 산출물도 연쇄로 생략한다.
export async function preskip(ctx, model, { stage, subs }) {
  const { planDocs } = await import('./prompt.mjs');
  const { reqCategory } = await import('./schema.mjs');
  const { skipFile } = await import('./model.mjs');
  const done = [];
  for (const sub of ctx.cfg.subsystems.map((x) => x.id)) {
    if (subs && !subs.includes(sub)) continue;
    // 이 단계 산출물 중 preskip이 기록한 생략은 지우고 아래에서 다시 판정한다(선행 산출물·요구사항이 생겼으면 풀리고, 그대로면 다시 기록)
    const skipNow = { ...(model.skipped[sub] || {}) };
    const before = new Set(Object.keys(skipNow));
    for (const [code, info] of Object.entries(skipNow)) {
      if (info?.by === 'preskip' && ctx.schemas.byCode[code]?.phase === stage) delete skipNow[code];
    }
    model.skipped[sub] = { ...skipNow };
    const plan = planDocs(ctx, stage, sub, model);
    const added = {};
    for (const code of plan) {
      if (skipNow[code] || model.has(sub, code)) continue;
      const s = ctx.schemas.byCode[code];
      let reason = null;
      for (const req of s.requires || []) {
        const rs = ctx.schemas.byCode[req];
        if (skipNow[req]) { reason = `선행 산출물 ${req} ${rs.name}을(를) 근거 부족으로 만들지 않았다 — ${s.basis}`; break; }
        if (!model.has(sub, req) && !plan.includes(req)) { reason = `선행 산출물 ${req} ${rs.name}이(가) 이 서브시스템에 없다 — ${s.basis}`; break; }
      }
      if (!reason && s.requires_reqs) {
        const cats = (model.get(sub, 'R1').requirements || []).map((r) => reqCategory(ctx.schemas, r.category)?.code);
        if (!cats.some((c) => s.requires_reqs.includes(c))) reason = `이 서브시스템의 사용자 요구사항 정의서에 ${s.requires_reqs.join('·')} 분류 요구사항이 없다 — ${s.basis}`;
      }
      if (!reason) continue;
      const needs = s.requires_reqs ? `${s.requires_reqs.join('·')} 요구사항(입력 근거)` : `선행 산출물(${(s.requires || []).join(', ')})을 쓸 수 있는 입력 자료`;
      skipNow[code] = added[code] = { reason, needs, sources: [], by: 'preskip', requires: s.requires || [] };
      if (!before.has(code)) done.push(`${sub}:${code}`);
    }
    for (const code of before) if (!skipNow[code] && !added[code]) done.push(`해제 ${sub}:${code}`);
    const changed = Object.keys(skipNow).length !== before.size || [...before].some((c) => !skipNow[c]);
    if (changed || Object.keys(added).length) await writeYaml(skipFile(ctx.p, sub), skipNow);
  }
  return done;
}

// ── 병합 후 서브시스템 간 엔티티 관계 보완: 테이블 fk_ref(다른 서브시스템 테이블) → 엔티티 relationships ──
// 병렬 작성 중에는 다른 서브시스템 ID를 쓰지 않으므로, 병합 뒤 FK 근거로 관계를 이어 준다(AI 판단 표시).
export async function linkCrossSub(ctx, model) {
  const tables = new Map();
  for (const d of Object.values(model.docs)) {
    if (d.code !== 'D9') continue;
    for (const t of d.data.tables || []) tables.set(t.id, { sub: d.sub, t });
  }
  const added = [];
  const touched = new Set();
  for (const { sub, t } of tables.values()) {
    const pkCols = (t.columns || []).filter((c) => c.pk === 'Y');
    for (const c of t.columns || []) {
      if (!c.fk_ref) continue;
      const [tb] = String(c.fk_ref).split('.');
      const target = tables.get(tb);
      if (!target || target.sub === sub || !t.entity_id || !target.t.entity_id) continue;
      const d8 = model.docs[`${sub}:D8`];
      const ent = (d8?.data.entities || []).find((e) => e.id === t.entity_id);
      if (!ent) continue;
      ent.relationships = ent.relationships || [];
      if (ent.relationships.some((r) => r.target === target.t.entity_id)) continue;
      const card = pkCols.length === 1 && pkCols[0].column_id === c.column_id ? '1:1' : 'N:1';
      ent.relationships.push({ target: target.t.entity_id, cardinality: card, optional: c.not_null === 'N' ? 'Y' : 'N', label: `${c.name || c.column_id}로 참조한다` });
      ent._meta = ent._meta || {};
      if (ent._meta.origin !== 'ai') ent._meta.ai_fields = [...new Set([...(ent._meta.ai_fields || []), 'relationships'])];
      touched.add(`${sub}:D8`);
      added.push(`${ent.id}→${target.t.entity_id}(${card})`);
    }
  }
  for (const k of touched) await writeYaml(model.docs[k].file, model.docs[k].data);
  return added;
}

// ── 소스코드 스캔 → I1 프로그램 목록 초안 ───────────────
const SRC_EXT = ['.java', '.kt', '.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.cs', '.go', '.jsp', '.html', '.xml', '.sql', '.php', '.rb', '.scala', '.swift', '.dart'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'target', 'out', 'bin', 'obj', '.idea', '.vscode', '__pycache__', '.next', 'coverage', 'vendor']);

export async function scanCode(ctx, model, { root, sub }) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); } else if (SRC_EXT.includes(path.extname(e.name).toLowerCase())) files.push(full);
    }
  };
  walk(path.resolve(root));
  const doc = model.get(sub, 'I1');
  const programs = doc.programs || [];
  const known = new Set(programs.map((p) => p.path).filter(Boolean));
  // 경로 없이 파일명만 적힌 기존 항목은 같은 파일명으로 보고 경로만 보완한다
  const byName = new Map(programs.filter((p) => !p.path && p.file_name).map((p) => [p.file_name, p]));
  let added = 0;
  for (const f of files.sort()) {
    const rel = path.relative(path.resolve(root), f).replace(/\\/g, '/');
    if (known.has(rel)) continue;
    const same = byName.get(path.basename(f));
    if (same) { same.path = rel; byName.delete(path.basename(f)); continue; }
    const [id] = nextIds(ctx.cfg, ctx.schemas, new Map([...model.index, ...programs.map((p) => [p.id, {}])]), 'PGM', { sub });
    programs.push({ id, file_name: path.basename(f), path: rel, _meta: { origin: 'derived', sources: [] } });
    added += 1;
  }
  doc.programs = programs;
  await writeYaml(modelFile(ctx.p, sub, 'I1'), doc);
  if (model.isSkipped(sub, 'I1')) {
    const { skipFile } = await import('./model.mjs');
    const rest = { ...model.skipped[sub] };
    delete rest.I1;
    await writeYaml(skipFile(ctx.p, sub), rest);
  }
  return { scanned: files.length, added };
}

export function statusRows(ctx, model, validation) {
  const rows = [];
  for (const d of Object.values(model.docs)) {
    let n = 0;
    for (const v of Object.values(d.data || {})) if (Array.isArray(v)) n += v.length; else if (v && typeof v === 'object') n += Object.keys(v).length;
    rows.push({
      sub: d.sub, code: d.code, name: ctx.schemas.byCode[d.code].name, items: n,
      errors: validation.errors.filter((e) => e.sub === d.sub && e.code === d.code).length,
      warnings: validation.warnings.filter((e) => e.sub === d.sub && e.code === d.code).length,
    });
  }
  return rows.sort((a, b) => a.sub.localeCompare(b.sub) || ctx.schemas.list.findIndex((s) => s.code === a.code) - ctx.schemas.list.findIndex((s) => s.code === b.code));
}

export function isBlankDoc(data) {
  return !data || Object.values(data).every((v) => isEmpty(v));
}
