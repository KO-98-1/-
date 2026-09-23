// 다이어그램: 모델 → Mermaid(또는 와이어프레임 HTML) → PNG
// 디자인 원칙(reference/diagram-style.md): 메커니즘을 그린다 · 화살표에 라벨 · 강조색은 초점 요소 하나 ·
// 흐름은 좌→우, 계층·트리는 위→아래 · 한 그림 한 주장(캡션).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dep, depDefault, findBrowser } from './deps.mjs';
import { lookup } from './model.mjs';

export const ACCENT = '#2b6cb0';
const INK = '#2d3748';
const LINE = '#4a5568';

export const MERMAID_CONFIG = {
  theme: 'base',
  fontFamily: '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif',
  themeVariables: {
    fontFamily: '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif',
    fontSize: '14px',
    primaryColor: '#ffffff',
    primaryBorderColor: LINE,
    primaryTextColor: '#1a202c',
    secondaryColor: '#f7fafc',
    tertiaryColor: '#ffffff',
    lineColor: LINE,
    clusterBkg: '#f7fafc',
    clusterBorder: ACCENT,
    edgeLabelBackground: '#ffffff',
    actorBkg: '#ffffff',
    actorBorder: LINE,
    actorTextColor: '#1a202c',
    signalColor: INK,
    signalTextColor: '#1a202c',
    noteBkgColor: '#fffbea',
    noteBorderColor: '#b7791f',
    labelBoxBkgColor: '#ffffff',
  },
  flowchart: { curve: 'basis', htmlLabels: true, nodeSpacing: 40, rankSpacing: 55, padding: 12 },
  sequence: { mirrorActors: false, actorMargin: 60, messageMargin: 40, showSequenceNumbers: false },
  er: { layoutDirection: 'TB', minEntityWidth: 120 },
  securityLevel: 'loose',
};

const safe = (s) => String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '_');
// 액터·컴포넌트처럼 교차가 많은 그림은 ELK 레이아웃이 더 정돈된다(직각 연결선, 좌우 배치 유지)
const ELK = '---\nconfig:\n  layout: elk\n  elk:\n    nodePlacementStrategy: NETWORK_SIMPLEX\n---\n';
const withElk = (def) => (def ? ELK + def : def);
const lbl = (s) => String(s ?? '').replace(/"/g, '#quot;').replace(/\n/g, '<br/>');

export function diagramPath(ctx, sub, kind, key) {
  return path.join(ctx.p.diagrams, sub, kind, `${safe(key)}.png`);
}

function nameOfId(model, id) {
  const hit = lookup(model, id);
  return hit?.entity?.name || String(id);
}

// ── 유스케이스 다이어그램 ────────────────────────────────
function ucdDef(ctx, model, sub, ucd) {
  const r2 = model.get(sub, 'R2');
  const ucs = (ucd.usecase_ids?.length ? ucd.usecase_ids.map((id) => lookup(model, id)?.entity).filter(Boolean)
    : (r2.usecases || []).filter((u) => u.ucd_id === ucd.id));
  if (!ucs.length) return null;
  const subName = ctx.cfg.subsystems.find((s) => s.id === sub)?.name || sub;
  const actorIds = [...new Set(ucs.flatMap((u) => u.actor_ids || []))];
  const aNode = new Map(actorIds.map((id, i) => [id, `A${i + 1}`]));
  const uNode = new Map(ucs.map((u, i) => [u.id, `U${i + 1}`]));
  const L = ['flowchart LR', '  classDef actor fill:none,stroke:none,font-size:15px', `  classDef uc fill:#ffffff,stroke:${LINE}`];
  const icon = (a) => (a?.kind === '시스템' ? 'fa:fa-server' : a?.kind === '조직' ? 'fa:fa-building' : 'fa:fa-user');
  const primary = [];
  const secondary = [];
  for (const id of actorIds) {
    const a = lookup(model, id)?.entity;
    (a?.type && a.type !== '주요' ? secondary : primary).push(id);
    L.push(`  ${aNode.get(id)}["${icon(a)}<br/>${lbl(a?.name || id)}"]:::actor`);
  }
  L.push(`  subgraph SYS["${lbl(subName)} 서브시스템"]`);
  for (const u of ucs) L.push(`    ${uNode.get(u.id)}(["${lbl(u.id)}<br/>${lbl(u.name)}"]):::uc`);
  L.push('  end');
  for (const u of ucs) {
    for (const a of u.actor_ids || []) {
      if (primary.includes(a)) L.push(`  ${aNode.get(a)} --- ${uNode.get(u.id)}`);
      else L.push(`  ${uNode.get(u.id)} --- ${aNode.get(a)}`);
    }
    for (const inc of u.includes || []) if (uNode.has(inc)) L.push(`  ${uNode.get(u.id)} -. "«include»" .-> ${uNode.get(inc)}`);
    for (const ext of u.extends || []) if (uNode.has(ext)) L.push(`  ${uNode.get(u.id)} -. "«extend»" .-> ${uNode.get(ext)}`);
  }
  L.push(`  style SYS fill:#f7fafc,stroke:${ACCENT},stroke-width:1.5px`);
  return L.join('\n');
}

// ── 시퀀스도 ────────────────────────────────────────────
function seqDef(model, sd) {
  const msgs = sd.messages || [];
  if (!msgs.length) return null;
  const order = [];
  const push = (x) => { if (x && !order.includes(x)) order.push(x); };
  (sd.actors || []).forEach(push);
  msgs.forEach((m) => { push(m.from); push(m.to); });
  (sd.classes || []).forEach(push);
  const alias = new Map(order.map((x, i) => [x, `P${i + 1}`]));
  const L = ['sequenceDiagram', '  autonumber'];
  for (const x of order) {
    const hit = lookup(model, x);
    const isActor = hit?.type === 'ACT' || (!hit && /담당자|사용자|관리자|고객|회원|책임자/.test(String(x)));
    L.push(`  ${isActor ? 'actor' : 'participant'} ${alias.get(x)} as ${String(hit?.entity?.name || x).replace(/[;#]/g, ' ')}`);
  }
  for (const m of msgs) {
    const a = alias.get(m.from);
    const b = alias.get(m.to) || a;
    const text = String(m.message || '').replace(/[;#]/g, ' ') || ' ';
    const arrow = m.kind === 'reply' ? '-->>' : m.kind === 'async' ? '-)' : '->>';
    L.push(`  ${a}${arrow}${b}: ${text}`);
    if (m.note) L.push(`  Note over ${b}: ${String(m.note).replace(/[;#]/g, ' ')}`);
  }
  return L.join('\n');
}

// ── 설계 클래스도 / 개념 클래스도 ───────────────────────
const VIS = { public: '+', private: '-', protected: '#', package: '~' };
const clean = (s) => String(s ?? '').replace(/[<>]/g, '~').replace(/[{}]/g, '').replace(/\n/g, ' ');

function classDef(model, sub, cd) {
  const d1 = model.get(sub, 'D1');
  let ids = cd.class_ids?.length ? [...cd.class_ids] : (d1.classes || []).filter((c) => (c.usecase_ids || []).includes(cd.usecase_id)).map((c) => c.id);
  for (const r of cd.relations || []) { if (!ids.includes(r.from)) ids.push(r.from); if (!ids.includes(r.to)) ids.push(r.to); }
  ids = ids.filter(Boolean);
  if (!ids.length) return null;
  const alias = new Map(ids.map((id, i) => [id, `C${i + 1}`]));
  const L = ['classDiagram'];
  for (const id of ids) {
    const c = lookup(model, id)?.entity || { name: id };
    const members = [];
    if (c.stereotype) members.push(`    <<${c.stereotype}>>`);
    (c.attributes || []).slice(0, 10).forEach((a) => members.push(`    ${VIS[a.visibility] || '+'}${clean(a.type)} ${clean(a.name)}`));
    if ((c.attributes || []).length > 10) members.push('    …');
    (c.operations || []).slice(0, 10).forEach((o) => members.push(`    ${VIS[o.visibility] || '+'}${clean(o.name)}(${clean(o.params || '')}) ${clean(o.return_type || '')}`.trimEnd()));
    if ((c.operations || []).length > 10) members.push('    …()');
    L.push(`  class ${alias.get(id)}["${lbl(c.name || id)}"]${members.length ? ' {' : ''}`);
    if (members.length) { L.push(...members); L.push('  }'); }
  }
  for (const r of cd.relations || []) {
    const a = alias.get(r.from);
    const b = alias.get(r.to);
    if (!a || !b) continue;
    const fm = r.from_mult ? ` "${r.from_mult}"` : '';
    const tm = r.to_mult ? `"${r.to_mult}" ` : '';
    const label = r.label ? ` : ${clean(r.label)}` : '';
    const t = r.type || 'association';
    if (t === 'inheritance') L.push(`  ${b} <|-- ${a}${label}`);
    else if (t === 'realization') L.push(`  ${b} <|.. ${a}${label}`);
    else if (t === 'aggregation') L.push(`  ${a}${fm} o-- ${tm}${b}${label}`);
    else if (t === 'composition') L.push(`  ${a}${fm} *-- ${tm}${b}${label}`);
    else if (t === 'dependency') L.push(`  ${a} ..> ${b}${label}`);
    else L.push(`  ${a}${fm} --> ${tm}${b}${label}`);
  }
  return L.join('\n');
}

function conceptDef(model, sub, ccd) {
  const cc = model.get(sub, 'CC');
  const ids = ccd.class_ids?.length ? ccd.class_ids : (cc.concept_classes || []).map((c) => c.id);
  if (!ids.length) return null;
  const alias = new Map(ids.map((id, i) => [id, `K${i + 1}`]));
  const L = ['flowchart LR', `  classDef b fill:#ffffff,stroke:${LINE}`, `  classDef c fill:#ffffff,stroke:${ACCENT},stroke-width:1.5px`, `  classDef e fill:#f7fafc,stroke:${LINE}`];
  for (const id of ids) {
    const c = lookup(model, id)?.entity || { name: id };
    const st = c.stereotype || '';
    const cls = st === 'Control' ? 'c' : st === 'Entity' ? 'e' : 'b';
    const shape = st === 'Entity' ? [`[("`, `")]`] : st === 'Control' ? ['(("', '"))'] : ['["', '"]'];
    L.push(`  ${alias.get(id)}${shape[0]}«${st || 'class'}»<br/>${lbl(c.name)}${shape[1]}:::${cls}`);
  }
  for (const r of ccd.relations || []) {
    if (alias.get(r.from) && alias.get(r.to)) L.push(`  ${alias.get(r.from)} -->${r.label ? `|"${lbl(r.label)}"|` : ''} ${alias.get(r.to)}`);
  }
  return L.join('\n');
}

// ── 사용자 인터페이스 구조도(메뉴 트리) ─────────────────
function uiTreeDef(ctx, model, sub) {
  const d2 = model.get(sub, 'D2');
  const subName = ctx.cfg.subsystems.find((s) => s.id === sub)?.name || sub;
  let tree = d2.ui_structure;
  if (!Array.isArray(tree) || !tree.length) {
    const screens = d2.screens || [];
    if (!screens.length) return null;
    tree = [];
    for (const s of screens) {
      const parts = String(s.menu_path || '').split(/\s*[>›/]\s*/).map((x) => x.trim()).filter(Boolean);
      if (parts.length && parts[parts.length - 1] === s.name) parts.pop();
      let level = tree;
      for (const p of parts) {
        let node = level.find((n) => n.name === p && !n.screen_id);
        if (!node) { node = { name: p, children: [] }; level.push(node); }
        level = node.children;
      }
      level.push({ name: s.name, screen_id: s.id });
    }
  }
  let n = 0;
  const L = [];
  const count = (nodes) => nodes.reduce((a, x) => a + 1 + count(x.children || []), 0);
  L.push(count(tree) > 28 ? 'flowchart LR' : 'flowchart TD');
  L.push(`  classDef menu fill:#ebf4ff,stroke:${ACCENT}`, `  classDef scr fill:#ffffff,stroke:${LINE}`, `  classDef root fill:${ACCENT},stroke:${ACCENT},color:#ffffff`);
  L.push(`  R["${lbl(subName)}"]:::root`);
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      const id = `N${++n}`;
      if (node.screen_id) L.push(`  ${id}["${lbl(node.screen_id)}<br/>${lbl(node.name)}"]:::scr`);
      else L.push(`  ${id}["${lbl(node.name)}"]:::menu`);
      L.push(`  ${parent} --> ${id}`);
      walk(node.children || [], id);
    }
  };
  walk(tree, 'R');
  return L.join('\n');
}

// ── 컴포넌트 구조도(초점 컴포넌트 + 의존관계, 레이어 구분) ─
const LAYERS = ['Presentation', 'Biz Logic', 'Integration', 'Data', 'Common'];

function componentDef(model, comp) {
  const all = [];
  for (const [id, info] of model.index) if (info.type === 'CMP') all.push(info.entity);
  const deps = (comp.depends_on || []).map((d) => ({ ...d, target: lookup(model, d.component_id)?.entity || { id: d.component_id, name: d.component_id } }));
  const users = all.filter((c) => c.id !== comp.id && (c.depends_on || []).some((d) => d.component_id === comp.id));
  const nodes = [comp, ...deps.map((d) => d.target), ...users].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);
  const alias = new Map(nodes.map((c, i) => [c.id, `M${i + 1}`]));
  const L = ['flowchart TB', `  classDef focus fill:#ebf4ff,stroke:${ACCENT},stroke-width:2px`, `  classDef other fill:#ffffff,stroke:${LINE}`];
  const byLayer = new Map();
  for (const c of nodes) {
    const layer = LAYERS.includes(c.layer) ? c.layer : '미분류';
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(c);
  }
  let li = 0;
  for (const layer of [...LAYERS, '미분류']) {
    if (!byLayer.has(layer)) continue;
    L.push(`  subgraph L${++li}["${layer}"]`);
    for (const c of byLayer.get(layer)) {
      L.push(`    ${alias.get(c.id)}["«component»<br/>${lbl(c.name || c.id)}<br/>${lbl(c.id)}"]:::${c.id === comp.id ? 'focus' : 'other'}`);
    }
    L.push('  end');
  }
  for (const d of deps) L.push(`  ${alias.get(comp.id)} -->|"${lbl(d.label || '사용')}"| ${alias.get(d.target.id)}`);
  for (const u of users) {
    const d = (u.depends_on || []).find((x) => x.component_id === comp.id);
    L.push(`  ${alias.get(u.id)} -->|"${lbl(d?.label || '사용')}"| ${alias.get(comp.id)}`);
  }
  return L.join('\n');
}

// ── ERD ─────────────────────────────────────────────────
const CARD = {
  '1:1': (o) => (o ? '||--o|' : '||--||'),
  '1:N': (o) => (o ? '||--o{' : '||--|{'),
  'N:1': (o) => (o ? '}o--o|' : '}|--||'),
  'N:M': () => '}o--o{',
};

function erdDef(model, sub, erd) {
  const d8 = model.get(sub, 'D8');
  let ids = erd.entity_ids?.length ? [...erd.entity_ids] : (d8.entities || []).map((e) => e.id);
  if (!ids.length) return null;
  const rels = [];
  for (const id of [...ids]) {
    const e = lookup(model, id)?.entity;
    for (const r of e?.relationships || []) {
      if (!r.target) continue;
      if (!ids.includes(r.target)) ids.push(r.target);
      rels.push({ from: id, ...r });
    }
  }
  const alias = new Map(ids.map((id, i) => [id, `E${i + 1}`]));
  const L = ['erDiagram'];
  for (const id of ids) {
    const e = lookup(model, id)?.entity || { name: id };
    // 그림에는 키 속성 우선 최대 10개(전체 속성은 엔티티 명세 표에 있음) — 축소로 글씨가 작아지는 것 방지
    const all = e.attributes || [];
    const keysFirst = [...all.filter((a) => a.pk === 'Y' || a.fk === 'Y'), ...all.filter((a) => a.pk !== 'Y' && a.fk !== 'Y')];
    const attrs = keysFirst.slice(0, 10);
    L.push(`  ${alias.get(id)}["${lbl(e.name || id)}"] {`);
    // Mermaid ER 속성 토큰은 문자·숫자·_-()[] 만 허용 → 그 밖의 기호(·, /, 공백 등)는 '_'로 치환
    const tok = (s) => String(s ?? '-').replace(/[^\p{L}\p{N}_\-()[\]]+/gu, '_').replace(/^_+|_+$/g, '') || '-';
    for (const a of attrs) {
      const type = tok(`${a.type || '-'}${a.length ? `(${String(a.length).replace(/\s+/g, '')})` : ''}`);
      const keys = [a.pk === 'Y' ? 'PK' : null, a.fk === 'Y' ? 'FK' : null].filter(Boolean).join(',');
      L.push(`    ${type} ${tok(a.name)}${keys ? ` ${keys}` : ''}`);
    }
    if (all.length > 10) L.push(`    생략 외_${all.length - 10}개_속성`); // ER 속성 문법(타입 이름, 이름은 문자로 시작)에 맞춘 생략 표시
    L.push('  }');
  }
  for (const r of rels) {
    const f = CARD[r.cardinality] || CARD['1:N'];
    L.push(`  ${alias.get(r.from)} ${f(r.optional === 'Y')} ${alias.get(r.target)} : "${lbl(r.label || '관계')}"`);
  }
  return L.join('\n');
}

// ── 화면 와이어프레임(HTML) ─────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wireframeHtml(screen) {
  const items = (screen.items || []).filter((i) => !/\bH\b/.test(String(i.attr || '').toUpperCase().replace(/\//g, ' ')));
  if (!items.length) return null;
  const attr = (i) => String(i.attr || '').toUpperCase().split(/[\s/,]+/);
  const isIn = (i) => attr(i).some((a) => a === 'I' || a === 'E');
  const isOut = (i) => !isIn(i) && attr(i).some((a) => a === 'O' || a === 'RO' || a === 'R');
  const inputs = items.filter(isIn);
  const outputs = items.filter(isOut);
  const listType = /조회|목록|대시보드/.test(screen.type || '') || outputs.length > 3;
  const btns = screen.buttons?.length ? screen.buttons
    : /조회/.test(screen.type || '') ? ['조회'] : /삭제/.test(screen.type || '') ? ['삭제'] : /갱신/.test(screen.type || '') ? ['수정', '저장'] : ['저장', '취소'];
  const field = (i) => `<div class="f"><label>${esc(i.name)}${/필수/.test(i.validation || '') ? '<b>*</b>' : ''}</label><div class="in ${/date|일자|날짜/i.test(`${i.type_length}${i.name}`) ? 'cal' : ''}">${/select|combo|콤보|선택/i.test(i.control || '') ? '<span class="dd">▼</span>' : ''}</div></div>`;
  const grid = listType && outputs.length
    ? `<table><tr>${outputs.slice(0, 8).map((o) => `<th>${esc(o.name)}</th>`).join('')}</tr>${[1, 2, 3].map(() => `<tr>${outputs.slice(0, 8).map(() => '<td></td>').join('')}</tr>`).join('')}</table>`
    : outputs.map((o) => `<div class="f"><label>${esc(o.name)}</label><div class="in ro"></div></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:16px;background:#fff;font:13px "Malgun Gothic","맑은 고딕",sans-serif;color:#2d3748}
  #wf{width:760px;border:1.5px solid #4a5568;border-radius:6px;overflow:hidden}
  .t{background:#edf2f7;border-bottom:1px solid #4a5568;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between}
  .t span{font-weight:normal;color:#718096}
  .c{padding:6px 12px;color:#718096;font-size:12px;border-bottom:1px dashed #cbd5e0}
  .b{padding:12px}
  .grp{border:1px solid #cbd5e0;border-radius:4px;padding:10px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
  .f{display:flex;align-items:center;gap:8px}.f label{width:110px;text-align:right;color:#4a5568}.f b{color:#c53030}
  .in{flex:1;height:24px;border:1px solid #a0aec0;border-radius:3px;background:#fff;position:relative}
  .in.ro{background:#f7fafc}.in.cal:after{content:"📅";position:absolute;right:4px;top:3px;font-size:12px}
  .dd{position:absolute;right:6px;top:4px;font-size:10px;color:#718096}
  table{width:100%;border-collapse:collapse;margin-bottom:10px}th{background:#edf2f7;font-weight:normal}
  th,td{border:1px solid #a0aec0;height:22px;padding:2px 6px;font-size:12px}
  .btns{display:flex;justify-content:flex-end;gap:8px}.btn{border:1px solid ${ACCENT};color:${ACCENT};border-radius:4px;padding:4px 14px}
  .btn:first-child{background:${ACCENT};color:#fff}
  </style></head><body><div id="wf">
  <div class="t">${esc(screen.name)}<span>${esc(screen.id)}</span></div>
  <div class="c">${esc(screen.menu_path || '')}</div>
  <div class="b">
   ${inputs.length ? `<div class="grp">${inputs.map(field).join('')}</div>` : ''}
   ${grid ? (listType ? grid : `<div class="grp">${grid}</div>`) : ''}
   <div class="btns">${btns.map((b) => `<span class="btn">${esc(b)}</span>`).join('')}</div>
  </div></div></body></html>`;
}

// ── 작업 목록 ───────────────────────────────────────────
export function diagramJobs(ctx, model, { subs = null } = {}) {
  const jobs = [];
  const want = (sub) => !subs || subs.includes(sub);
  for (const d of Object.values(model.docs)) {
    if (!want(d.sub)) continue;
    const { sub, code, data } = d;
    const add = (kind, key, def, extra = {}) => { if (def) jobs.push({ sub, kind, key, def, ...extra }); };
    if (code === 'R2') for (const u of data.ucds || []) add('ucd', u.id, u.mermaid || withElk(ucdDef(ctx, model, sub, u)));
    if (code === 'D1') {
      for (const s of data.sequences || []) add('seq', s.id, s.mermaid || seqDef(model, s));
      for (const c of data.class_diagrams || []) add('class', c.id, c.mermaid || classDef(model, sub, c));
    }
    if (code === 'D2') {
      add('uitree', sub, uiTreeDef(ctx, model, sub));
      for (const s of data.screens || []) add('wireframe', s.id, wireframeHtml(s), { html: true });
    }
    if (code === 'D3') for (const c of data.components || []) add('component', c.id, c.mermaid || withElk(componentDef(model, c)));
    if (code === 'D8') for (const e of data.erds || []) add('erd', e.id, e.mermaid || erdDef(model, sub, e));
    if (code === 'CC') for (const c of data.concept_diagrams || []) add('concept', c.id, c.mermaid || withElk(conceptDef(model, sub, c)));
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.mermaid === 'string' && k !== 'sections') add('narr', `${code}-${k}`, v.mermaid);
    }
    for (const [k, v] of Object.entries(data.sections || {})) if (v && typeof v.mermaid === 'string') add('narr', `${code}-${k}`, v.mermaid);
  }
  return jobs;
}

export async function renderDiagrams(ctx, model, { subs = null, force = false, log = () => {} } = {}) {
  const jobs = diagramJobs(ctx, model, { subs });
  const todo = [];
  for (const j of jobs) {
    const png = diagramPath(ctx, j.sub, j.kind, j.key);
    const src = png.replace(/\.png$/, j.html ? '.html' : '.mmd');
    const hash = crypto.createHash('sha1').update(j.def + JSON.stringify(MERMAID_CONFIG)).digest('hex');
    const hashFile = png.replace(/\.png$/, '.hash');
    fs.mkdirSync(path.dirname(png), { recursive: true });
    fs.writeFileSync(src, j.def, 'utf8');
    if (!force && fs.existsSync(png) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) continue;
    todo.push({ ...j, png, hashFile, hash, src });
  }
  const result = { total: jobs.length, rendered: 0, cached: jobs.length - todo.length, errors: [] };
  if (!todo.length) return result;
  const exe = findBrowser();
  if (!exe) {
    result.errors.push({ key: '*', message: 'Chrome/Edge를 찾지 못했습니다. SWD_BROWSER 환경변수로 브라우저 경로를 지정하세요.' });
    return result;
  }
  const puppeteer = await depDefault('puppeteer');
  const mcli = await dep('@mermaid-js/mermaid-cli');
  const browser = await puppeteer.launch({ headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const j of todo) {
      try {
        let data;
        if (j.html) {
          const page = await browser.newPage();
          await page.setViewport({ width: 820, height: 600, deviceScaleFactor: 2 });
          await page.setContent(j.def, { waitUntil: 'load' });
          const el = await page.$('#wf');
          data = await el.screenshot({ type: 'png' });
          await page.close();
        } else {
          ({ data } = await mcli.renderMermaid(browser, j.def, 'png', {
            viewport: { width: 1100, height: 800, deviceScaleFactor: 2 },
            mermaidConfig: MERMAID_CONFIG,
            backgroundColor: 'white',
          }));
        }
        fs.writeFileSync(j.png, data);
        fs.writeFileSync(j.hashFile, j.hash);
        result.rendered += 1;
        log(`  그림 ${j.sub}/${j.kind}/${j.key}`);
      } catch (e) {
        if (fs.existsSync(j.png)) fs.rmSync(j.png);
        result.errors.push({ sub: j.sub, kind: j.kind, key: j.key, source: path.relative(ctx.p.root, j.src), message: String(e.message || e).split('\n').slice(0, 4).join(' ') });
      }
    }
  } finally {
    await browser.close();
  }
  return result;
}
