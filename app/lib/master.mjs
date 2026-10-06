// 마스터 작업(모델 호출): 설정 제안 → 분석 배분표 → 설계 준비(공용 DB·데이터 소유권)
// 사람이 스킬 절차서(SKILL.md)대로 하던 판단을 모델에게 맡기되, 가이드와 킷 참고 문서를 그대로 넘긴다.
import fs from 'node:fs';
import path from 'node:path';
import { KIT_SKILL, lib, loadInputs, numbered, parseYaml, readYamlFile, writeYamlFile, loadModel } from './engine.mjs';
import { parseBlocks } from './blocks.mjs';

const ref = (name) => fs.readFileSync(path.join(KIT_SKILL, 'reference', name), 'utf8');

export const MASTER_SYSTEM = [
  '너는 「CBD SW개발 표준 산출물 관리 가이드」(2011.12)에 따라 산출물 작성을 지휘하는 마스터다.',
  '입력 자료에 근거가 있는 것만 사실로 다루고, 이름·수치·일정·제품명을 지어내지 않는다. 가이드에 없는 기준을 새로 만들지 않는다.',
  '입력에서 결정되지 않은 방법·방식(외부 서비스 연계 여부, 기술 선택 등)을 결정된 것처럼 지시하지 않는다. 미정은 미정으로 넘긴다.',
  '구분: 지어내면 안 되는 것은 입력에 없는 "사실"(이름·수치·일정·제품·정책·결정)이다. 요구사항을 만족하기 위해 가이드 작성 방법상 도출하는 "설계"(엔티티·테이블·키 컬럼·클래스·화면·시험 케이스)는 AI 제안으로 설계하는 것이 정상이며, 근거 부족을 이유로 막지 않는다.',
  '출력은 지시한 파일 블록(=== FILE: … / === END)만 쓴다. 블록 밖에 설명을 쓰지 않는다.',
].join('\n');

function inputsAppendix(inputs) {
  const L = ['## 입력 자료(정규화 텍스트, 줄 번호)', ''];
  for (const x of inputs) L.push(`### ${x.id} — ${x.kind} · ${x.title}${x.date ? ` (${x.date})` : ''}`, '```text', numbered(x.content), '```', '');
  return L.join('\n');
}

async function ask(provider, prompt, { cwd, signal, logFile, expect }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text } = await provider.complete({ system: MASTER_SYSTEM, prompt: attempt ? `${prompt}\n\n(이전 응답에 오류가 있었다: ${lastErr}. 지시한 블록 형식을 정확히 지켜 다시 출력하라.)` : prompt, cwd, signal, logFile });
    const blocks = parseBlocks(text);
    const hit = blocks.filter((b) => b.type === 'FILE' && expect.includes(b.target));
    if (hit.length === expect.length) {
      try {
        const parsed = {};
        for (const b of hit) parsed[b.target] = await parseYaml(b.body);
        return parsed;
      } catch (e) { lastErr = `YAML 구문 오류 — ${e.message.split('\n')[0]}`; continue; }
    }
    lastErr = `필요한 블록(${expect.join(', ')})이 없음`;
  }
  throw new Error(`마스터 응답을 해석하지 못했습니다: ${lastErr}`);
}

// ── 0. 설정 제안 ─────────────────────────────────────────
export async function proposeConfig(ctx, provider, opts = {}) {
  const inputs = await loadInputs(ctx);
  const prompt = [
    '# 작업: 산출물 작성 설정(sw-config) 제안', '',
    '아래 입력 자료를 모두 읽고 산출물 작성 설정을 제안한다.', '',
    '- `project.system_name`: 입력에 나온 시스템(서비스) 이름. `project.name`: 사업·프로젝트 이름(입력에 없으면 시스템 이름으로 짧게 — 팀·조직·작성자 이름을 프로젝트 이름으로 쓰지 않는다). `project.id`: 시스템 이름의 영문 대문자 2~6자 약어.',
    '- `document.author`, `document.approver`: 입력 자료에 작성 주체·승인자(팀명·직책 등)가 나올 때만 쓴다. 없으면 빈 문자열.',
    '- `subsystems`: 입력에서 결정된 업무 영역(기능 묶음)을 기준으로 2~6개, 그리고 여러 영역에 걸친 요구(권한·성능·보안·품질 등)를 담는 `COM`(공통)을 둔다. 게시판처럼 독립된 업무 기능은 COM에 넣지 말고 별도 영역이나 가장 가까운 업무 영역에 둔다. `id`는 영문 대문자 2~5자, `name`은 한글, `description`은 입력에 나온 기능만 쓴다.',
    '- `deliverables.skip`: 가이드 Ⅰ.3 "관련 업무가 존재하지 않는 경우는 산출물 생략 가능" — 데이터 전환·초기데이터 구축 언급이 없으면 `D12`. 그 밖에는 넣지 않는다.',
    '- `deliverables.optional`: 가이드 Ⅳ 선택 산출물. 풀이가 필요한 용어가 여럿이면 `GL`(용어집), 개념 클래스 모형이 필요하면 `CC`.',
    '- `reasons`: 각 결정의 근거(입력ID:줄)를 짧게.', '',
    '출력 형식:', '```', '=== FILE: sw-config.patch.yaml',
    'project: {id: …, name: "…", system_name: "…"}', 'document: {author: "…", approver: "…"}',
    'subsystems:', '  - {id: …, name: …, description: …}', 'deliverables: {skip: [D12], optional: [GL]}', 'reasons: {subsystems: "…", skip: "…"}', '=== END', '```', '',
    inputsAppendix(inputs),
  ].join('\n');
  const r = await ask(provider, prompt, { ...opts, expect: ['sw-config.patch.yaml'] });
  const patch = r['sw-config.patch.yaml'] || {};
  applyConfigPatch(ctx.p.config, patch);
  return patch;
}

// 주석을 살리기 위해 템플릿의 해당 줄·블록만 바꾼다
export function applyConfigPatch(file, patch) {
  let s = fs.readFileSync(file, 'utf8');
  const q = (v) => JSON.stringify(String(v ?? ''));
  const setScalar = (section, key, value) => {
    if (value === undefined) return;
    const re = new RegExp(`(^${section}:[\\s\\S]*?^\\s+${key}:\\s*)([^#\\n]*?)(\\s*(#.*)?)$`, 'm');
    s = re.test(s) ? s.replace(re, (_, a, _b, c) => `${a}${key === 'id' ? String(value) : q(value)}${c}`) : s;
  };
  setScalar('project', 'id', patch.project?.id);
  setScalar('project', 'name', patch.project?.name);
  setScalar('project', 'system_name', patch.project?.system_name);
  setScalar('document', 'author', patch.document?.author);
  setScalar('document', 'approver', patch.document?.approver);
  if (Array.isArray(patch.subsystems) && patch.subsystems.length) {
    const block = ['subsystems:', ...patch.subsystems.flatMap((x) => [`  - id: ${x.id}`, `    name: ${q(x.name)}`, `    description: ${q(x.description || '')}`]), ''].join('\n');
    s = s.replace(/^subsystems:\n(?:[ \t]+.*\n|\s*\n)*?(?=^\S)/m, `${block}\n`);
  }
  const list = (v) => `[${(v || []).join(', ')}]`;
  if (patch.deliverables?.skip) s = s.replace(/^(\s+skip:\s*)\[[^\]]*\]/m, `$1${list(patch.deliverables.skip)}`);
  if (patch.deliverables?.optional) s = s.replace(/^(\s+optional:\s*)\[[^\]]*\]/m, `$1${list(patch.deliverables.optional)}`);
  fs.writeFileSync(file, s, 'utf8');
}

// ── 1. 분석 배분표(.work/allocation.yaml) ──────────────────
export async function allocateAnalysis(ctx, provider, opts = {}) {
  const inputs = await loadInputs(ctx);
  const { activeDeliverables } = await lib('schema.mjs');
  const glOn = activeDeliverables(ctx.schemas, ctx.cfg).some((s) => s.code === 'GL');
  const subs = ctx.cfg.subsystems.map((x) => `- ${x.id} ${x.name}: ${x.description || ''}`).join('\n');
  const prompt = [
    '# 작업: 분석단계 서브시스템 배분표 작성', '',
    '서브시스템별 작성자(병렬로 일하며 서로의 결과를 보지 못한다)에게 줄 배분표를 만든다. 작성자는 이 배분표와 입력 원문만 보고 사용자 요구사항 정의서(R1)와 유스케이스 명세서(R2)를 쓴다.', '',
    '## 서브시스템', subs, glOn ? '- SYSTEM: 시스템 공통 — 용어집(GL)만 작성' : '', '',
    '## 배분표에 반드시 담을 것',
    '- `shared.analysis_notes`(전 서브시스템 공통 지시): [프로젝트 핵심 이해] 시스템의 핵심 목적과 주요 개념 구분, [입력 성격] 각 입력이 결정·계획·아이디어·사업관리 정보 중 무엇인지와 쓰는 법, [미정] 추후 결정으로 남은 항목과 근거 줄(수치·방법을 지어내지 말고 tbd), [입력 간 차이·충돌] 서로 다른 기술과 처리 원칙(최신 날짜 우선, 보고), [ID] 다른 서브시스템 ID를 만들거나 참조하지 않는다, [근거 부족] 가이드 작성 목적의 핵심 내용을 쓸 근거가 없으면 그 산출물은 만들지 않고 _skip.yaml에 남긴다.',
    '- 서브시스템마다 `inputs`: {입력ID: "시작-끝(요지), …"} — 그 서브시스템 작성자가 읽어야 할 줄을 빠짐없이. `notes`: 담당 기능 목록(입력 근거), 비워 둘 것·미정, 다른 서브시스템과의 경계(누가 무엇을 쓰는지).',
    '- 여러 영역에 걸친 비기능 요구(성능·보안·품질)와 공통 기능은 COM에 준다. 입력에 없는 기능(공통코드·알림·관리자 등)을 만들어 배분하지 않는다.',
    glOn ? '- `SYSTEM`: 용어집 작성용 — 입력 전체와 용어 후보 목록.' : '', '',
    '## 참고: 입력 자료에서 사실 추출하기(킷 참고 문서)', ref('extraction.md'), '',
    '출력 형식:', '```', '=== FILE: allocation.yaml', 'shared:', '  analysis_notes: >-', '    …', 'MB:', '  inputs:', '    MTG-001: "16-34(…), 81-94(…)"', '  notes: >-', '    …', '=== END', '```', '',
    inputsAppendix(inputs),
  ].filter((x) => x !== '').join('\n');
  const r = await ask(provider, prompt, { ...opts, expect: ['allocation.yaml'] });
  const alloc = r['allocation.yaml'] || {};
  const file = path.join(ctx.p.work, 'allocation.yaml');
  const prev = (await readYamlFile(file, {})) || {};
  await writeYamlFile(file, mergeAlloc(prev, alloc));
  return alloc;
}

function mergeAlloc(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(prev[k] || {}), ...v } : v;
  return out;
}

// ── 2. 설계 준비: 공용 DB(model/SYSTEM/D9.yaml databases) + 데이터 소유권 표 ──
export async function prepareDesign(ctx, provider, opts = {}) {
  const model = await loadModel(ctx);
  const { schemaSection } = await lib('prompt.mjs');
  const d9 = schemaSection(ctx, ctx.schemas.byCode.D9, 'SYSTEM');
  const docs = Object.values(model.docs).filter((d) => ['R1', 'R2'].includes(d.code));
  const L = [
    '# 작업: 설계단계 준비(공용 데이터베이스와 데이터 소유권 표)', '',
    '서브시스템별 설계 작성자가 병렬로 클래스·ERD·DB·화면·컴포넌트·시험을 설계한다. 서로의 결과를 보지 못하므로 같은 테이블이 중복 설계되지 않게 미리 정한다.', '',
    '1. `model/SYSTEM/D9.yaml`에 공용 데이터베이스를 `databases`로 정의한다(ID `DB-01`…). 입력에 DB 구성 근거가 없으면 1개로 두고 `_meta: {origin: ai}`로 표시한다. 테이블·테이블스페이스는 쓰지 않는다.',
    '2. `design-notes.yaml`에 지시를 쓴다:',
    '   - `shared.design_notes`: 핵심 엔티티·테이블 물리명(`TB_<SUB>_<영문>`)과 그 **PK 컬럼 물리명·타입**(예: `TB_MB_USER.USER_ID VARCHAR(36)`)을 어느 서브시스템이 정의하는지 표(데이터 소유권) — 다른 서브시스템의 fk_ref는 이 컬럼명·타입을 그대로 쓴다, 다른 서브시스템은 `fk_ref`(예: `TB_MB_ARTIST.ARTIST_ID`)로만 참조한다는 것, 병렬 작성 중에는 다른 서브시스템 ID를 relationships·depends_on에 넣지 않는다는 것, 성능·보안·품질 요구사항의 시스템시험 시나리오(D7)는 COM만 작성하며 모든 서브시스템의 해당 요구사항을 다룬다는 것.',
    '   - `<SUB>.design_notes`: 서브시스템별 추가 지시(담당 테이블, 참조할 다른 서브시스템 테이블, 주의점).',
    '   - 요구사항을 만족하는 데 필요한 데이터(요청·계산 결과·추천 결과·이력 등 요구사항에 조회·확인·비교가 나오는 데이터)는 그 서브시스템 소유 테이블로 설계하게 한다(AI 제안). 요구사항과 무관한 테이블·기능은 만들지 않는다. 입력에 속성 목록이 없는 엔티티(프로필 항목 등)는 식별·연결 컬럼만 두라고 지시한다.',
    '   - fk_ref 대상 컬럼을 tbd로 두게 하지 않는다. 핵심 테이블의 PK 컬럼명·타입은 이 표에서 확정한다(설계 결정 — AI 제안).',
    '   - 입력에서 미정인 사실(계산 공식·수치 기준·처리 환경·외부 서비스·검증 방법 등)은 설계에서도 결정하지 말고 tbd로 남기라고 지시한다. 테이블·컬럼·키 같은 설계 구조는 tbd 대상이 아니다.',
    '   - 서브시스템 사이 연결(다른 서브시스템 데이터 사용)은 fk_ref와 설명 문장으로만 나타내라고 지시한다.', '',
    '## D9 스키마(공용 데이터베이스 부분)', d9, '',
    '출력 형식:', '```', '=== FILE: model/SYSTEM/D9.yaml', 'databases:', '  - id: DB-01', '    name: …', '    _meta: {origin: ai}', '=== END',
    '=== FILE: design-notes.yaml', 'shared:', '  design_notes: >-', '    …', 'MB:', '  design_notes: >-', '    …', '=== END', '```', '',
    '## 설정', `DBMS: ${ctx.cfg.database?.dbms || 'postgresql'} · 서브시스템: ${ctx.cfg.subsystems.map((x) => `${x.id} ${x.name}`).join(', ')}`, '',
    '## 분석 산출물(R1·R2)',
  ];
  for (const d of docs) L.push(`### model/${d.sub}/${d.code}.yaml`, '```yaml', fs.readFileSync(d.file, 'utf8').trimEnd(), '```', '');
  const r = await ask(provider, L.join('\n'), { ...opts, expect: ['model/SYSTEM/D9.yaml', 'design-notes.yaml'] });
  const sysD9 = path.join(ctx.p.model, 'SYSTEM', 'D9.yaml');
  const prevD9 = (await readYamlFile(sysD9, {})) || {};
  await writeYamlFile(sysD9, { ...prevD9, databases: r['model/SYSTEM/D9.yaml']?.databases || prevD9.databases || [] });
  const file = path.join(ctx.p.work, 'allocation.yaml');
  await writeYamlFile(file, mergeAlloc((await readYamlFile(file, {})) || {}, r['design-notes.yaml'] || {}));
  return r;
}

// ── 3. 수정사항 영향 분석(확인 요청용) ─────────────────────
// 반환: {changes: [{no, summary, source, conflict, conflict_reason, affected: [{sub, docs, ids}], proposal}]}
export async function analyzeChange(ctx, provider, inputId, opts = {}) {
  const inputs = await loadInputs(ctx);
  const cr = inputs.find((x) => x.id === inputId);
  if (!cr) throw new Error(`입력 ${inputId}를 찾을 수 없습니다(먼저 정규화 필요)`);
  const model = await loadModel(ctx);
  const others = inputs.filter((x) => x.id !== inputId);
  const L = [
    `# 작업: 수정사항 ${inputId} 영향 분석`, '',
    '이미 작성된 산출물(모델)에 수정사항을 반영하기 전에 사용자에게 확인받을 변경 목록을 만든다. 반영은 하지 않는다.', '',
    '- 수정사항의 요청을 항목별로 나눈다(`no` 1부터, `source`는 입력ID:줄).',
    '- 항목마다 영향받는 산출물을 요구사항 → 유스케이스 → 클래스·화면·컴포넌트·테이블 → 시험 순으로 모델에서 찾는다(`affected`: 서브시스템, 산출물 코드, 영향 ID).',
    '- 충돌 판정(`conflict: true`): 회의 결정(fact)이나 확인된(confirmed) 항목과 반대되는 변경, 이미 정해진 수치·범위의 변경. `conflict_reason`에 근거(입력ID:줄 또는 ID)를 쓴다.',
    '- `proposal`: 무엇을 어떻게 바꿀지 한두 문장. 입력에 없는 값을 지어내지 않는다.', '',
    '출력 형식:', '```', '=== FILE: change-review.yaml', 'changes:', '  - no: 1', '    summary: "…"', `    source: "${inputId}:4"`, '    conflict: false', '    conflict_reason: ""',
    '    affected:', '      - {sub: MT, docs: [R1, R2, D2], ids: [SFR-MT-006, UC-MT-001]}', '    proposal: "…"', '=== END', '```', '',
    `## 수정사항 ${inputId} — ${cr.title}`, '```text', numbered(cr.content), '```', '',
    '## 기존 입력 자료(결정 근거 확인용)',
  ];
  for (const x of others) L.push(`### ${x.id} — ${x.kind} · ${x.title}`, '```text', numbered(x.content), '```', '');
  L.push('## 현재 산출물(모델)');
  for (const d of Object.values(model.docs)) L.push(`### model/${d.sub}/${d.code}.yaml`, '```yaml', fs.readFileSync(d.file, 'utf8').trimEnd(), '```', '');
  const r = await ask(provider, L.join('\n'), { ...opts, expect: ['change-review.yaml'] });
  const review = r['change-review.yaml'] || { changes: [] };
  const dir = path.join(ctx.p.work, 'changes');
  fs.mkdirSync(dir, { recursive: true });
  await writeYamlFile(path.join(dir, `${inputId}-review.yaml`), { input: inputId, analyzed_at: new Date().toISOString(), ...review });
  return review;
}

// ── 4. 설계 병합 뒤 서브시스템 간 컴포넌트 의존(depends_on) 보완 ─────
// 병렬 작성 중에는 다른 서브시스템 ID를 쓰지 않으므로, 병합 뒤 D3 컴포넌트·D4 인터페이스를 근거로 서브시스템 간 호출 관계를 잇는다.
export async function linkComponents(ctx, provider, opts = {}) {
  const model = await loadModel(ctx);
  const d3 = Object.values(model.docs).filter((d) => d.code === 'D3' && d.sub !== 'SYSTEM');
  if (d3.length < 2) return [];
  const comps = new Map();
  for (const d of d3) for (const c of d.data.components || []) comps.set(c.id, { sub: d.sub, c, doc: d });
  const L = [
    '# 작업: 서브시스템 간 컴포넌트 의존 관계 보완', '',
    '각 서브시스템 설계는 병렬로 작성되어 다른 서브시스템 컴포넌트를 depends_on에 넣지 않았다. 아래 컴포넌트·인터페이스 설계를 보고, 한 서브시스템 컴포넌트가 다른 서브시스템 컴포넌트의 기능·데이터를 호출·사용하는 관계만 찾는다.',
    '- 근거: 인터페이스 설계(D4)의 송수신, 컴포넌트 설명·인터페이스 오퍼레이션, 요구사항에 나온 서브시스템 간 데이터 사용(예: 일정·신뢰 정보·작업물 참조).',
    '- 같은 서브시스템 안의 관계, 근거 없는 관계는 넣지 않는다. 없으면 빈 목록을 낸다.', '',
    '출력 형식:', '```', '=== FILE: component-links.yaml', 'links:', '  - {from: CMP-MT-02, to: CMP-MY-01, label: "공연 가능 일정 조회(IF-MT-001)"}', '=== END', '```', '',
  ];
  for (const d of d3) L.push(`### model/${d.sub}/D3.yaml`, '```yaml', fs.readFileSync(d.file, 'utf8').trimEnd(), '```', '');
  for (const d of Object.values(model.docs).filter((x) => x.code === 'D4')) L.push(`### model/${d.sub}/D4.yaml`, '```yaml', fs.readFileSync(d.file, 'utf8').trimEnd(), '```', '');
  const r = await ask(provider, L.join('\n'), { ...opts, expect: ['component-links.yaml'] });
  const added = [];
  const touched = new Set();
  for (const l of r['component-links.yaml']?.links || []) {
    const a = comps.get(l.from);
    const b = comps.get(l.to);
    if (!a || !b || a.sub === b.sub) continue; // 없는 ID·같은 서브시스템은 버린다
    a.c.depends_on = a.c.depends_on || [];
    if (a.c.depends_on.some((x) => (x.component_id || x) === l.to)) continue;
    a.c.depends_on.push({ component_id: l.to, label: String(l.label || '서브시스템 간 호출') });
    a.c._meta = a.c._meta || {};
    if (a.c._meta.origin !== 'ai') a.c._meta.ai_fields = [...new Set([...(a.c._meta.ai_fields || []), 'depends_on'])];
    touched.add(a.doc);
    added.push(`${l.from}→${l.to}`);
  }
  for (const d of touched) await writeYamlFile(d.file, d.data);
  return added;
}
