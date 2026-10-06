// 셀 값 해석: 필드 값 → 표시 문자열 + 상태(ok / missing / tbd / blank) + AI 제안 여부
// 렌더러와 검토 리포트가 같은 규칙을 쓰도록 한 곳에 모은다.
import { isEmpty, lookup } from './model.mjs';

export function getPath(obj, keyPath) {
  if (!obj || !keyPath) return undefined;
  let cur = obj;
  for (const k of String(keyPath).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

// 레이아웃 셀 스펙의 key 가 가리키는 값의 소유 객체·필드명·메타를 찾는다.
export function locate(spec, row) {
  let key = spec.key;
  let owner = row.entity;
  if (key && key.startsWith('parent.')) { owner = row.parent; key = key.slice(7); }
  else if (key && key.startsWith('item.')) { owner = row.item; key = key.slice(5); }
  const segs = key ? key.split('.') : [];
  const field = segs[0] || null;
  let holder = owner;
  for (let i = 0; i < segs.length - 1; i++) holder = holder?.[segs[i]];
  const value = key ? getPath(owner, key) : undefined;
  const meta = (owner && owner._meta) || row.meta || null;
  return { owner, field, leaf: segs[segs.length - 1], value, meta, holder };
}

export function isAiUnconfirmed(meta, field) {
  if (!meta || meta.confirmed) return false;
  if (meta.origin === 'ai') return true;
  return Array.isArray(meta.ai_fields) && field && meta.ai_fields.includes(field);
}

export function tbdOf(meta, field) {
  if (!meta || !meta.tbd || !field) return null;
  if (Array.isArray(meta.tbd)) return meta.tbd.includes(field) ? '' : null;
  return Object.prototype.hasOwnProperty.call(meta.tbd, field) ? String(meta.tbd[field] ?? '') : null;
}

// YAML에서 '이름: 설명'처럼 쓴 목록 항목은 객체가 된다 → '이름: 설명' 문장으로 되돌린다
function pairText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(pairText).join(', ');
  return Object.entries(v).filter(([k]) => k !== '_meta').map(([k, x]) => `${k}: ${pairText(x)}`).join(', ');
}

function asLines(value, format, join) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value === 'string') return value.split('\n').map((x) => x.replace(/\s+$/, ''));
  if (Array.isArray(value)) {
    if (format === 'flows') {
      const out = [];
      for (const f of value) {
        if (typeof f === 'string') { out.push(f); continue; }
        if (f?.name) out.push(f.name);
        (f?.steps || []).forEach((s, i) => out.push(`  ${i + 1}) ${typeof s === 'string' ? s : pairText(s)}`));
      }
      return out;
    }
    const items = value.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.name ?? v?.text ?? pairText(v))));
    if (format === 'steps' || format === 'numbered') {
      return items.map((s, i) => (/^\s*(\d+[).]|[가-힣][.)])\s/.test(s) ? s : `${i + 1}) ${s}`));
    }
    if (format === 'bullets') return items.length > 1 ? items.map((s) => (/^\s*[-•·]/.test(s) ? s : `- ${s}`)) : items;
    if (join && join !== '\n') return [items.join(join)];
    return items;
  }
  if (typeof value === 'object') {
    return Object.entries(value).filter(([k]) => k !== '_meta').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return [String(value)];
}

// 파생 값(출처 문서 목록 등) — 입력 자료 사실이 아니라 다른 데이터에서 기계적으로 도출
function derive(name, loc, row, rctx) {
  const meta = loc.meta || {};
  if (name === 'sources_docs') {
    const ids = [...new Set((meta.sources || []).map((s) => String(s).split(':')[0]))];
    return ids.map((id) => {
      const inp = rctx.inputIndex?.get(id);
      if (!inp) return id;
      // 가이드 R1 '요구사항 출처': 문서번호와 문서명 — 제목 앞의 [분류] 표시와 제목 속 날짜는 빼고 일자는 한 번만
      const date = inp.date || '';
      let title = String(inp.title || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '');
      if (date) title = title.replace(new RegExp(`\\(?${date.replace(/-/g, '[-./]')}\\)?`, 'g'), '');
      title = title.replace(/\s{2,}/g, ' ').replace(/^[\s·,-]+|[\s·,-]+$/g, '');
      return `${id} ${title}${date ? `(${date})` : ''}`;
    });
  }
  if (name === 'actor_names') {
    return (row.entity?.actor_ids || []).map((id) => lookup(rctx.model, id)?.entity?.name || id);
  }
  if (name === 'requirement_desc') {
    const hit = lookup(rctx.model, row.entity?.requirement_id);
    return hit?.entity?.description || null;
  }
  if (name === 'req_usecases') {
    const req = row.entity?.requirement_id;
    const out = [];
    for (const [id, info] of rctx.model.index) {
      if (info.type === 'UC' && (info.entity.requirement_ids || []).includes(req)) out.push(id);
    }
    return out;
  }
  return null;
}

// 반환: {lines, state, ai}
//  state: ok | missing(정보 부족) | tbd(미정) | blank(의도적 공란: 결과 칸·선택 항목·버전)
export function resolveCell(spec, row, rctx) {
  if (spec.value !== undefined) return { lines: asLines(spec.value), state: 'ok', ai: false };
  if (spec.ctx) {
    const v = getPath(rctx.ctxVars, spec.ctx);
    return isEmpty(v) ? { lines: [], state: 'missing', ai: false } : { lines: asLines(v), state: 'ok', ai: false };
  }
  // 결과 칸: 결과를 기록하지 않는 산출물(설계단계 시나리오 등)은 항상 공란
  if (spec.result && !rctx.schema.results) return { lines: [], state: 'blank', ai: false };

  let loc;
  if (spec.lookup) {
    const idLoc = locate({ key: spec.lookup }, row);
    const hit = lookup(rctx.model, idLoc.value);
    const v = hit ? getPath(hit.entity, spec.field || 'name') : undefined;
    loc = { ...idLoc, field: idLoc.field, value: v };
    if (isEmpty(idLoc.value)) {
      const tbd = tbdOf(idLoc.meta, idLoc.field);
      if (tbd !== null) return { lines: [], state: 'tbd', ai: false, field: idLoc.field };
      return { lines: [], state: 'missing', ai: false, field: idLoc.field };
    }
    if (!hit) return { lines: [String(idLoc.value)], state: 'ok', ai: isAiUnconfirmed(idLoc.meta, idLoc.field) };
    return { lines: asLines(v, spec.format, spec.join), state: isEmpty(v) ? 'missing' : 'ok', ai: false };
  }

  loc = locate(spec, row);
  let value = loc.value;
  let derived = false;
  const tbd = tbdOf(loc.meta, loc.field);
  if (tbd !== null && isEmpty(value)) return { lines: [], state: 'tbd', ai: false, field: loc.field, reason: tbd };

  if (isEmpty(value) && spec.lookup_self) {
    const idv = loc.owner?.id;
    const hit = lookup(rctx.model, idv);
    if (hit?.entity?.name) { value = hit.entity.name; derived = true; }
  }
  if (isEmpty(value) && spec.derive) {
    const dv = derive(spec.derive, loc, row, rctx);
    if (!isEmpty(dv)) { value = dv; derived = true; }
  }
  // 빈 목록([])을 명시했으면 '없음이 확실함' → 해당 없음 (키 생략은 '모름' → 정보 부족)
  if (Array.isArray(value) && value.length === 0) return { lines: [], state: 'none', ai: false, field: loc.field };
  if (isEmpty(value)) {
    const silent = spec.blank === 'silent' || rctx.silentFields?.has(loc.leaf) || rctx.silentFields?.has(loc.field);
    return { lines: [], state: silent ? 'blank' : 'missing', ai: false, field: loc.field };
  }
  if (spec.lookup_names && Array.isArray(value)) {
    value = value.map((id) => lookup(rctx.model, id)?.entity?.name || id);
  }
  const join = spec.join ?? (row.inKv ? ', ' : '\n');
  const lines = asLines(value, spec.format, join);
  return { lines, state: 'ok', ai: !derived && isAiUnconfirmed(loc.meta, loc.field), field: loc.field };
}

// 같은 필드명이 여러 곳에 있으면 모든 곳이 '선택 항목(blank: silent)'일 때만 공란 허용으로 본다.
export function collectSilentFields(schema) {
  const silent = new Map();
  const walk = (fields) => {
    for (const [k, f] of Object.entries(fields || {})) {
      if (!f || typeof f !== 'object') continue;
      const isSilent = f.blank === 'silent';
      silent.set(k, silent.has(k) ? silent.get(k) && isSilent : isSilent);
      if (f.fields) walk(f.fields);
    }
  };
  for (const e of Object.values(schema.entities || {})) walk(e.fields);
  const out = new Set(['_meta', 'mermaid']);
  for (const [k, v] of silent) if (v) out.add(k);
  return out;
}
