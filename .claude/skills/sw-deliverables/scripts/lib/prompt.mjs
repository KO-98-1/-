// 서브에이전트 작성 지시서(프롬프트) 생성
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, SCRIPTS_DIR } from './deps.mjs';
import { readYaml, subsystemById } from './project.mjs';
import { activeDeliverables, PHASE_NAMES } from './schema.mjs';
import { nextIds } from './ids.mjs';
import { modelFile } from './model.mjs';
import { loadInputIndex } from './ingest.mjs';

// 단계별 작성 대상(의존 순서). 결과서(I2·T1·T2·T7)·추적표(R3)·DDL(I3)은 프로그램이 파생한다.
const PLAN = {
  analysis: { sub: ['R1', 'R2', 'CC'], system: ['GL'] },
  design: { sub: ['D1', 'D8', 'D9', 'D2', 'D3', 'D4', 'D11', 'D10', 'D7'], system: ['D9', 'D5', 'D6', 'D12'] },
  implementation: { sub: ['I1'], system: [] },
  test: { sub: ['T6', 'T3'], system: ['T4', 'T5'] },
};
const READS = {
  analysis: [],
  design: ['R1', 'R2', 'CC'],
  implementation: ['R2', 'D2', 'D3', 'D11'],
  test: ['R1', 'R2', 'D2', 'D5', 'D10'],
};

export function planDocs(ctx, stage, sub) {
  const active = new Set(activeDeliverables(ctx.schemas, ctx.cfg).map((s) => s.code));
  const list = (sub === 'SYSTEM' ? PLAN[stage]?.system : PLAN[stage]?.sub) || [];
  return list.filter((c) => active.has(c));
}

function typeLabel(f) {
  if (!f || typeof f !== 'object') return '문자열';
  switch (f.type) {
    case 'ids': return `ID 목록${f.ref ? `(${f.ref})` : ''}`;
    case 'list': return '문자열 목록';
    case 'steps': return '단계 목록(순서대로)';
    case 'flows': return '[{name, steps:[…]}]';
    case 'object-list': return '객체 목록';
    case 'object': return '객체';
    case 'text': return '여러 줄 문자열';
    case 'mermaid': return 'Mermaid 코드';
    default: return f.ref ? `ID(${f.ref})` : '문자열';
  }
}

function fieldRows(fields, prefix = '') {
  const rows = [];
  for (const [k, f] of Object.entries(fields || {})) {
    if (!f || typeof f !== 'object' || k === '_meta') continue;
    const notes = [];
    if (f.required) notes.push('**필수**');
    if (f.blank === 'silent') notes.push('선택');
    if (f.result) notes.push('시험결과 칸');
    if (f.enum) notes.push(`허용값: ${f.enum.join(' / ')}`);
    if (f.enum_ref) notes.push('허용값: 요구사항 구분 목록');
    if (f.id_type) notes.push(`ID 유형 ${f.id_type}`);
    rows.push(`| \`${prefix}${k}\` | ${f.label || k} | ${typeLabel(f)} | ${[f.desc, notes.join(', ')].filter(Boolean).join(' — ')} |`);
    if (f.fields) rows.push(...fieldRows(f.fields, `${prefix}${k}[].`));
  }
  return rows;
}

function skeletonValue(f, depth) {
  const pad = '  '.repeat(depth);
  if (!f || typeof f !== 'object') return ' <값>';
  if (f.type === 'object-list' || f.type === 'object') {
    const inner = Object.entries(f.fields || {}).filter(([k, x]) => k !== '_meta' && x && typeof x === 'object' && !x.result).slice(0, 7);
    const lines = inner.map(([k, x], i) => `${pad}${i === 0 && f.type === 'object-list' ? '- ' : '  '}${k}:${skeletonValue(x, depth + 2)}`);
    return `\n${lines.join('\n')}`;
  }
  if (['ids', 'list', 'steps'].includes(f.type)) return ` [<${f.label || '항목'}>, …]`;
  if (f.type === 'flows') return ' [{name: "가. <분기명>", steps: [<단계>, …]}]';
  if (f.enum) return ` <${f.enum.slice(0, 3).join('|')}>`;
  return ` <${f.label || '값'}>`;
}

function skeleton(schema) {
  const L = [];
  for (const [coll, e] of Object.entries(schema.entities || {})) {
    if (e.system_level && schema.code === 'D9') L.push('# (databases 는 model/SYSTEM/D9.yaml 에만 작성)');
    if (e.type === 'sections') {
      L.push('sections:', '  "1.1":', '    text: |', '      <본문>', '    _meta: {origin: fact, sources: [MTG-001:10-20]}',
        '  "3.1":', '    table:', '      columns: [<목차에 정의된 열 그대로>]', '      rows:', '        - [<값>, <값>]', '    _meta: {origin: ai, sources: [MTG-001:30-33]}');
      continue;
    }
    if (e.type === 'tree') { L.push(`${coll}:  # 선택. 비우면 화면 menu_path로 자동 구성`, '  - name: <메뉴>', '    children:', '      - {name: <화면명>, screen_id: <SCR-ID>}'); continue; }
    if (e.type === 'object') {
      L.push(`${coll}:`);
      for (const [k, f] of Object.entries(e.fields || {})) if (k !== '_meta') L.push(`  ${k}:${skeletonValue(f, 2)}`);
      L.push('  _meta: {origin: ai, sources: [MTG-001:40-45]}');
      continue;
    }
    L.push(`${coll}:`);
    const entries = Object.entries(e.fields || {}).filter(([k]) => k !== '_meta');
    entries.forEach(([k, f], i) => {
      if (f?.result) return;
      L.push(`  ${i === 0 ? '- ' : '  '}${k}:${skeletonValue(f, 3)}`);
    });
    L.push('    _meta: {origin: fact, sources: [MTG-001:12-18], ai_fields: [<추정한 필드>], tbd: {<미정 필드>: "<사유>"}}');
  }
  return L.join('\n');
}

function schemaSection(ctx, schema, sub) {
  const file = path.relative(ctx.p.root, modelFile(ctx.p, sub, schema.code)).replace(/\\/g, '/');
  const L = [];
  L.push(`### ${schema.code} ${schema.name}  →  \`${file}\``);
  L.push(`- 작성 목적: ${schema.purpose}`);
  L.push(`- 작성 방법: ${schema.method}`);
  if (schema.skippable) L.push(`- 생략 조건: ${schema.skippable}`);
  if (schema.results === false) L.push('- 이 산출물은 시험결과(result)를 기술하지 않는다.');
  for (const [coll, e] of Object.entries(schema.entities || {})) {
    if (sub !== 'SYSTEM' && e.system_level) { L.push(`- \`${coll}\`: model/SYSTEM/${schema.code}.yaml 에 있음(읽기 전용, ID로 참조)`); continue; }
    if (sub === 'SYSTEM' && schema.code === 'D9' && !e.system_level) continue;
    L.push('', `#### \`${coll}\`${e.id_type ? ` — ID 유형 ${e.id_type}` : ''}`, e.desc ? `${e.desc}` : '');
    if (e.fields) L.push('', '| 키 | 항목 | 형식 | 작성 방법 / 허용값 |', '|---|---|---|---|', ...fieldRows(e.fields));
  }
  if (schema.outline) {
    L.push('', '#### 목차(outline) — `sections`의 키는 아래 번호를 쓴다');
    for (const n of schema.outline) {
      if (n.repeat) { L.push(`- ${n.num} (반복: \`${n.repeat}\` 항목마다) — 하위: ${(n.children || []).map((c) => `${c.num} ${c.title}`).join(', ')}`); continue; }
      L.push(`- ${n.num} ${n.title || n.plain_title || ''}${n.key ? ` → key \`${n.key}\`` : ''}${n.table ? ` · 표 열: [${n.table.columns.join(', ')}]` : ''}${n.diagram ? ' · 그림(mermaid)' : ''}${n.desc ? ` — ${n.desc}` : ''}`);
    }
  }
  L.push('', '형식 예시(값은 입력 자료로 채운다):', '```yaml', skeleton(schema), '```', '');
  return L.join('\n');
}

function idTable(ctx, model, sub, docs) {
  const types = new Set();
  for (const code of docs) {
    const s = ctx.schemas.byCode[code];
    for (const e of Object.values(s.entities || {})) {
      if (e.system_level && sub !== 'SYSTEM') continue; // 공용 DB 등은 SYSTEM에서만 정의
      if (e.id_type) types.add(e.id_type);
      const walk = (fields) => Object.values(fields || {}).forEach((f) => { if (f?.fields?.id?.id_type) types.add(f.fields.id.id_type); walk(f?.fields); });
      walk(e.fields);
    }
  }
  const L = ['| 유형 | 규칙 | 이 서브시스템의 다음 번호 |', '|---|---|---|'];
  const cats = ctx.schemas.common.requirement_categories;
  for (const t of types) {
    const tpl = ctx.cfg.ids?.element?.[t] || '';
    let next = '';
    if (t === 'REQ') next = [...new Set(cats.map((c) => c.code))].map((c) => nextIds(ctx.cfg, ctx.schemas, model.index, 'REQ', { sub, cat: c })[0]).join(', ');
    else if (/\{parent\}/.test(tpl)) next = '상위 ID + "-01"';
    else if (/\{name\}/.test(tpl)) next = tpl.replace('{sub}', sub).replace('{name}', '<영문명>');
    else if (/\{sub\}/.test(tpl) || /\{n/.test(tpl)) next = nextIds(ctx.cfg, ctx.schemas, model.index, t, { sub: sub === 'SYSTEM' ? 'COM' : sub })[0];
    L.push(`| ${t} | \`${tpl}\` | ${next} |`);
  }
  return L.join('\n');
}

export async function buildPrompt(ctx, model, opts) {
  const { stage, sub, docs: docsOverride } = opts;
  const docs = docsOverride || planDocs(ctx, stage, sub);
  const s = subsystemById(ctx.cfg, sub) || { id: sub, name: sub };
  const inputs = await loadInputIndex(ctx.p);
  const alloc = (await readYaml(path.join(ctx.p.work, 'allocation.yaml'), {})) || {};
  const focus = alloc[sub] || alloc.subsystems?.[sub] || null;
  const swd = path.join(SCRIPTS_DIR, 'swd.mjs');
  const rules = fs.readFileSync(path.join(SKILL_DIR, 'reference', 'writing-rules.md'), 'utf8');
  const diagramRules = fs.readFileSync(path.join(SKILL_DIR, 'reference', 'diagram-style.md'), 'utf8');
  const rel = (f) => path.relative(ctx.p.root, f).replace(/\\/g, '/');
  const writeFiles = docs.map((c) => rel(modelFile(ctx.p, sub, c)));
  const readFiles = [];
  for (const c of READS[stage] || []) {
    for (const x of model.subsOf(c)) readFiles.push(`${rel(modelFile(ctx.p, x, c))}${x === sub ? '' : ' (다른 서브시스템 — ID 참조용)'}`);
  }
  if (stage === 'design' && sub !== 'SYSTEM' && model.has('SYSTEM', 'D9')) readFiles.push('model/SYSTEM/D9.yaml (데이터베이스 ID 참조)');
  if (stage === 'design' && sub === 'SYSTEM') for (const x of model.subsOf('D3')) readFiles.push(rel(modelFile(ctx.p, x, 'D3')));

  const L = [];
  const title = opts.change ? `수정사항 반영 지시서 — ${opts.change.inputId}` : `산출물 작성 지시서 — ${PHASE_NAMES[stage]}단계`;
  L.push(`# ${title} · ${sub === 'SYSTEM' ? '시스템 공통' : `서브시스템 ${s.id} ${s.name}`}`, '');
  L.push('너는 CBD SW 표준 산출물 작성 담당 서브에이전트다. 이 지시서만 따른다. 문서(.docx)는 프로그램이 만들므로 너는 **YAML 데이터만** 쓴다.', '');
  L.push('## 1. 담당 범위', '');
  L.push(`- 작업 폴더(산출물 루트): \`${ctx.p.root}\` — 아래 경로는 모두 이 폴더 기준`);
  L.push(`- 시스템: ${ctx.cfg.project?.system_name || '(미설정)'} / 서브시스템: ${s.id} ${s.name}${s.description ? ` — ${s.description}` : ''}`);
  L.push(`- 작성할 산출물(이 순서로): ${docs.map((c) => `${c} ${ctx.schemas.byCode[c].name}`).join(' → ')}`);
  L.push(`- **쓰기 허용 파일**: ${writeFiles.map((f) => `\`${f}\``).join(', ')} (이미 있으면 기존 내용을 유지·보완한다. 다른 파일은 수정 금지)`);
  if (readFiles.length) L.push(`- 읽기 전용 참고: ${readFiles.map((f) => `\`${f}\``).join(', ')}`);
  L.push(`- 서브시스템 목록(교차 참조용): ${ctx.cfg.subsystems.map((x) => `${x.id} ${x.name}`).join(', ')}`, '');

  L.push('## 2. 입력 자료(근거)', '');
  L.push('Read 도구로 아래 정규화 텍스트를 읽는다(원본 파일은 읽지 않는다). 근거 줄 번호를 `_meta.sources`에 `입력ID:시작-끝`으로 남긴다.', '');
  L.push('| 입력ID | 종류 | 제목 | 일자 | 파일 | 이 서브시스템 관련 줄 |', '|---|---|---|---|---|---|');
  for (const x of inputs.values()) {
    if (x.status !== 'ok') continue;
    const f = focus?.inputs?.[x.id] ?? focus?.[x.id] ?? '';
    L.push(`| ${x.id} | ${x.kind} | ${x.title} | ${x.date || ''} | \`${x.text}\` | ${Array.isArray(f) ? f.join(', ') : f} |`);
  }
  if (focus?.notes || focus?.summary) L.push('', `마스터의 배분 메모: ${focus.notes || focus.summary}`);
  const stageNotes = focus?.[`${stage}_notes`];
  if (stageNotes) L.push('', `**${PHASE_NAMES[stage]}단계 마스터 지시(반드시 준수):** ${stageNotes}`);
  if (alloc.shared?.[`${stage}_notes`]) L.push('', `**전 서브시스템 공통 지시:** ${alloc.shared[`${stage}_notes`]}`);
  L.push('');

  const demote = (md) => md.replace(/^# .*\n/, '').replace(/^## /gm, '### ');
  L.push('## 3. 작성 원칙 (반드시 준수)', '', demote(rules), '');
  L.push('## 4. ID 규칙과 다음 번호', '', idTable(ctx, model, sub, docs), '');
  L.push('## 5. 산출물별 스키마', '');
  for (const code of docs) L.push(schemaSection(ctx, ctx.schemas.byCode[code], sub));
  if (docs.some((c) => ['D5', 'D6', 'D12', 'T4', 'T5'].includes(c))) L.push('## 부록. 다이어그램 스타일', '', demote(diagramRules), '');

  L.push('## 6. 작업 순서', '');
  if (opts.change) {
    L.push(`**이번 작업은 신규 작성이 아니라 수정사항 반영이다.** 근거: \`${opts.change.inputId}\` (\`.work/inputs/${opts.change.inputId}.txt\`)`);
    L.push('', '사용자가 승인한 변경 목록(이것만 반영한다):', '', opts.change.notes, '');
    L.push('1. 수정사항 입력과 쓰기 허용 파일의 현재 내용을 읽는다.');
    L.push('2. 승인된 변경에 해당하는 항목만 고친다. 관련 없는 항목·ID·문장은 그대로 둔다. ID는 바꾸지 않고, 새 항목이 필요하면 다음 번호를 쓴다.');
    L.push(`3. 바뀐 항목의 \`_meta.sources\`에 \`${opts.change.inputId}:줄범위\`를 추가한다. 변경으로 새로 추정한 필드는 \`ai_fields\`에 넣고, 해당 항목의 \`confirmed\`는 제거한다(재검토 대상).`);
    L.push('4. 변경 때문에 더 이상 맞지 않게 된 문장(예: 이전 수치·이전 개수)이 같은 파일 안에 남지 않도록 모두 찾아 고친다.');
  } else {
    L.push('1. 입력 자료와 읽기 전용 참고 파일을 모두 읽는다.');
    L.push('2. 위 순서대로 각 YAML 파일을 작성한다(Write 도구, UTF-8). 앞 산출물의 ID를 뒤 산출물이 참조하도록 일관되게 연결한다.');
  }
  L.push(`3. 검증: \`node "${swd}" validate --root "${ctx.p.root}" --sub ${sub} --docs ${docs.join(',')}\``);
  L.push('   - **오류(error)는 0건이 될 때까지** 고친다. 경고 중 추적성 누락은 가능한 한 해소하고, 입력 근거가 없어 해소할 수 없으면 그대로 둔다.');
  L.push('   - 다른 서브시스템 ID를 참조해 생기는 "참조 대상 없음" 오류는 그 ID가 아직 작성되지 않았을 수 있다 — 보고서에 적고 넘어간다.');
  L.push('4. 문서(docx) 렌더링은 하지 않는다(마스터가 병합 후 수행).', '');
  L.push('## 7. 결과 보고 (마지막 메시지, 이 형식 그대로, 20줄 이내)', '');
  L.push('```', `서브시스템: ${sub}`, '작성: <코드>(<컬렉션> <개수>, …), …', '검증: 오류 <n> / 경고 <n>', 'AI 제안: <n>건 — 주요: <요약>', '미정: <n>건 — <요약>', '핵심 질문: <정보가 없어 비워 둔 것 중 사용자에게 물어야 할 것, 최대 5개>', '충돌·이슈: <입력 자료 간 모순, 다른 서브시스템과 맞춰야 할 ID 등>', '```');
  return L.join('\n');
}

export async function writePrompt(ctx, model, opts) {
  const text = await buildPrompt(ctx, model, opts);
  fs.mkdirSync(ctx.p.prompts, { recursive: true });
  const file = path.join(ctx.p.prompts, opts.change ? `change_${opts.change.inputId}_${opts.sub}.md` : `${opts.stage}_${opts.sub}.md`);
  fs.writeFileSync(file, text, 'utf8');
  return { file, chars: text.length };
}
