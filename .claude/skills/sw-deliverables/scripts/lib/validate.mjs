// 검증기: ID 형식·유일성·참조 무결성·출처 메타·단계 규칙·허용값·추적성
import { parseId } from './ids.mjs';
import { lookup, isEmpty } from './model.mjs';
import { reqCategory } from './schema.mjs';
import { loadInputIndex, parseSource } from './ingest.mjs';

const ID_LIKE = new Set(['id', 'name']);

export async function validate(ctx, model, { subs = null, codes = null } = {}) {
  const { cfg, schemas } = ctx;
  const inputs = await loadInputIndex(ctx.p);
  const issues = [];
  const add = (level, where, message) => issues.push({ level, ...where, message });

  // --sub 지정 시 다른 서브시스템(병렬 작성 중일 수 있음)의 파일 오류·중복은 보고하지 않는다
  const subOfFile = (file) => { const m = String(file).replace(/\\/g, '/').match(/\/model\/([^/]+)\//); return m ? m[1] : null; };
  for (const e of model.errors) if (!subs || subs.includes(subOfFile(e.file))) add('error', { file: e.file, sub: subOfFile(e.file) }, e.message);
  for (const d of model.dupes) {
    const involved = [d.a.split(':')[0], d.b.split(':')[0]];
    if (!subs || involved.some((s) => subs.includes(s))) add('error', { id: d.id }, `ID 중복: ${d.id} (${d.a}, ${d.b})`);
  }

  const want = (d) => (!subs || subs.includes(d.sub)) && (!codes || codes.includes(d.code));

  // 생략 기록(model/<SUB>/_skip.yaml): 사유가 있어야 하고, 같은 산출물의 모델 파일과 함께 있으면 안 된다
  for (const [sub, map] of Object.entries(model.skipped || {})) {
    if (subs && !subs.includes(sub)) continue;
    for (const [code, info] of Object.entries(map || {})) {
      const where = { sub, code, field: '_skip.yaml' };
      if (!schemas.byCode[code]) { add('error', where, `생략 기록의 산출물 코드 오류: '${code}'`); continue; }
      if (codes && !codes.includes(code)) continue;
      if (!info || typeof info !== 'object' || isEmpty(info.reason)) add('error', where, '생략 사유(reason)가 없습니다 — 가이드 작성 목적의 어떤 내용을 쓸 근거가 없는지 적으세요');
      else if (isEmpty(info.needs)) add('warning', where, '생략을 해소하는 데 필요한 자료(needs)가 없습니다');
      if (model.has(sub, code)) add('error', where, `생략으로 기록했는데 model/${sub}/${code}.yaml 도 있습니다 — 하나만 남기세요`);
    }
  }

  const checkMeta = (meta, where, { required = true } = {}) => {
    if (!meta) { if (required) add('error', where, '출처 메타(_meta) 누락: origin(fact|ai|derived)과 sources를 기록해야 합니다'); return; }
    if (!['fact', 'ai', 'derived'].includes(meta.origin)) add('error', where, `_meta.origin 값 오류: '${meta.origin}' (fact|ai|derived)`);
    if (meta.origin === 'fact' && isEmpty(meta.sources)) add('error', where, 'origin=fact 인데 sources(근거 위치)가 없습니다');
    for (const s of meta.sources || []) {
      const ps = parseSource(s);
      if (!ps) { add('error', where, `sources 형식 오류: '${s}' (예: MTG-001:12-18)`); continue; }
      const inp = inputs.get(ps.id);
      if (!inp) add('error', where, `sources의 입력 ID가 없습니다: ${ps.id}`);
      else if (ps.to && inp.lines && ps.to > inp.lines + 1) add('warning', where, `sources 줄 범위가 문서 길이(${inp.lines}줄)를 넘습니다: ${s}`);
    }
    if (meta.ai_fields && !Array.isArray(meta.ai_fields)) add('error', where, '_meta.ai_fields 는 필드명 목록이어야 합니다');
  };

  const checkRef = (refType, value, where, label) => {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (isEmpty(v)) continue;
      const hit = lookup(model, v);
      if (!hit) add('error', where, `${label}: 참조 대상 없음 '${v}' (${refType})`);
      else if (hit.type !== refType) add('error', where, `${label}: '${v}'는 ${refType}가 아니라 ${hit.type} 입니다`);
    }
  };

  const checkFields = (fields, obj, where, sub, parentId, schema) => {
    for (const [fname, f] of Object.entries(fields || {})) {
      if (!f || typeof f !== 'object' || fname === '_meta') continue;
      const v = obj?.[fname];
      const w = { ...where, field: fname };
      if (f.required && isEmpty(v)) {
        const tbd = obj?._meta?.tbd && Object.prototype.hasOwnProperty.call(obj._meta.tbd, fname);
        if (ID_LIKE.has(fname) || f.ref) add('error', w, `필수 항목 누락: ${f.label || fname}`);
        else if (!tbd) add('warning', w, `필수 항목 비어 있음(문서에 '정보 부족'으로 표시): ${f.label || fname}`);
      }
      if (isEmpty(v)) continue;
      if (f.result && !schema.results) add('error', w, `${schema.code}는 시험결과를 기술하지 않는 산출물입니다(가이드: 설계단계에서는 기술하지 않음)`);
      const enumList = f.enum || (f.enum_ref === 'requirement_categories' ? schemas.common.requirement_categories.map((c) => c.name) : null);
      if (enumList && f.type !== 'object-list') {
        for (const x of Array.isArray(v) ? v : [v]) if (!enumList.includes(String(x))) add('error', w, `허용값 아님: '${x}' (허용: ${enumList.join(', ')})`);
      }
      if (f.ref) checkRef(f.ref, v, w, f.label || fname);
      if ((f.type === 'ids' || f.type === 'list') && !Array.isArray(v)) add('warning', w, `${f.label || fname}은(는) 목록 형식(- 항목)이어야 합니다`);
      if (f.type === 'object-list') {
        if (!Array.isArray(v)) { add('error', w, `${f.label || fname}은(는) 객체 목록이어야 합니다`); continue; }
        v.forEach((child, i) => {
          const cw = { ...where, field: `${fname}[${i}]` };
          const idType = f.fields?.id?.id_type;
          if (idType && child?.id) {
            const pr = parseId(cfg, schemas, idType, child.id);
            if (!pr.ok) add('error', cw, `ID 형식 오류: '${child.id}' (규칙 ${cfg.ids?.element?.[idType]})`);
            else if (pr.groups.parent && parentId && pr.groups.parent !== parentId) add('error', cw, `하위 ID '${child.id}'는 상위 ID '${parentId}-'로 시작해야 합니다`);
            else if (pr.groups.sub && pr.groups.sub !== sub && sub !== 'SYSTEM') add('warning', cw, `ID의 서브시스템(${pr.groups.sub})이 문서 서브시스템(${sub})과 다릅니다`);
          }
          if (f.fields) checkFields(f.fields, child, { ...cw, id: child?.id || where.id }, sub, child?.id || parentId, schema);
        });
      }
    }
  };

  for (const d of Object.values(model.docs)) {
    if (!want(d)) continue;
    const schema = schemas.byCode[d.code];
    const where = { sub: d.sub, code: d.code };
    if (schema.generated && d.code === 'R3') { add('warning', where, 'R3는 자동 생성 산출물입니다. model/…/R3.yaml은 무시됩니다'); continue; }
    const known = new Set([...Object.keys(schema.entities || {}), '_meta']);
    for (const k of Object.keys(d.data || {})) if (!known.has(k)) add('warning', where, `스키마에 없는 키: '${k}' (무시됨)`);
    if (schema.scope === 'system' && d.sub !== 'SYSTEM') add('warning', where, `${d.code}는 시스템 공통 산출물입니다. model/SYSTEM/${d.code}.yaml에 작성하세요`);

    for (const [coll, espec] of Object.entries(schema.entities || {})) {
      const val = d.data?.[coll];
      if (val === undefined || val === null) continue;
      if (espec.type === 'sections') {
        if (typeof val !== 'object' || Array.isArray(val)) { add('error', { ...where, field: coll }, 'sections는 {목차번호: {text, table, mermaid, _meta}} 형식이어야 합니다'); continue; }
        const keys = new Set();
        const collect = (nodes) => nodes.forEach((n) => { if (n.key) keys.add(String(n.key)); });
        collect(schema.outline || []);
        for (const [k, sec] of Object.entries(val)) {
          const w = { ...where, field: `sections.${k}` };
          if (!keys.has(String(k))) add('warning', w, `목차에 없는 절 번호: ${k}`);
          checkMeta(sec?._meta, w);
        }
        continue;
      }
      if (espec.type === 'object' || espec.type === 'tree') {
        if (espec.type === 'object') checkMeta(val?._meta, { ...where, field: coll }, { required: !isEmpty(val) });
        continue;
      }
      if (!Array.isArray(val)) { add('error', { ...where, field: coll }, `${coll}은(는) 목록이어야 합니다`); continue; }
      const seen = new Set();
      val.forEach((item, i) => {
        const w = { ...where, id: item?.id || `${coll}[${i}]` };
        if (!item || typeof item !== 'object') { add('error', w, '항목이 객체가 아닙니다'); return; }
        checkMeta(item._meta, w, { required: !schema.derived_from });
        if (espec.id_type && item.id && !espec.id_is_ref) {
          const pr = parseId(cfg, schemas, espec.id_type, item.id);
          if (!pr.ok) add('error', w, `ID 형식 오류: '${item.id}' (규칙 ${cfg.ids?.element?.[espec.id_type]})`);
          else if (pr.groups.sub && pr.groups.sub !== d.sub && d.sub !== 'SYSTEM') add('warning', w, `ID의 서브시스템(${pr.groups.sub})이 문서 서브시스템(${d.sub})과 다릅니다`);
          if (espec.id_type === 'REQ' && pr.ok && item.category) {
            const cat = reqCategory(schemas, item.category);
            if (cat && pr.groups.cat && cat.code !== pr.groups.cat) add('error', w, `요구사항 구분 '${item.category}'의 분류코드는 ${cat.code}인데 ID는 ${pr.groups.cat}입니다`);
          }
        }
        if (espec.id_is_ref && item.id) checkRef(espec.id_type, item.id, w, 'ID');
        if (espec.unique_key) {
          const k = espec.unique_key.map((f) => item[f]).join('|');
          if (seen.has(k)) add('error', w, `중복 항목: ${espec.unique_key.join('+')} = ${k}`);
          seen.add(k);
        }
        checkFields(espec.fields, item, w, d.sub, item.id, schema);
      });
    }
    // 파생 산출물: 원본에 없는 ID 경고
    if (schema.derived_from) {
      const src = model.get(d.sub, schema.derived_from);
      const srcIds = new Set(JSON.stringify(src).match(/"id":"[^"]+"/g) || []);
      const myIds = JSON.stringify(d.data).match(/"id":"[^"]+"/g) || [];
      for (const x of myIds) if (!srcIds.has(x)) add('warning', where, `원본(${schema.derived_from})에 없는 ID: ${x.slice(6, -1)} — 원본을 먼저 수정하세요`);
    }
  }

  // 화면 항목 속성(I/O/RO/E/H)
  for (const d of Object.values(model.docs)) {
    if (d.code !== 'D2' || !want(d)) continue;
    for (const s of d.data.screens || []) {
      for (const it of s.items || []) {
        for (const tok of String(it.attr || '').toUpperCase().split(/[\s/,]+/).filter(Boolean)) {
          if (tok === 'R') add('warning', { sub: d.sub, code: 'D2', id: s.id, field: 'items.attr' }, `속성 'R'은 가이드 항목 설명 기준 'RO'(ReadOnly)로 표기하세요 (${it.name})`);
          else if (!['I', 'O', 'RO', 'E', 'H'].includes(tok)) add('error', { sub: d.sub, code: 'D2', id: s.id, field: 'items.attr' }, `속성 값 오류 '${tok}' (${it.name}) — I, O, RO, E, H 중 선택`);
        }
      }
    }
  }

  // 추적성 경고도 필터 범위(서브시스템·산출물) 안의 것만
  traceChecks(ctx, model, (level, where, message) => { if (want(where)) add(level, where, message); }, want);

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return { ok: errors.length === 0, errors, warnings, issues };
}

function traceChecks(ctx, model, add, want) {
  const { schemas } = ctx;
  const ofType = (t) => [...model.index.entries()].filter(([, i]) => i.type === t).map(([id, i]) => ({ id, ...i }));
  const exists = (code) => Object.values(model.docs).some((d) => d.code === code);
  // 단서 부족으로 생략한 산출물은 추적 대상에서 뺀다(없는 게 정상)
  const on = (sub, code) => exists(code) && !model.isSkipped(sub, code);
  const reqs = ofType('REQ');
  const ucs = ofType('UC');
  const w = (x, code) => ({ sub: x.sub, code, id: x.id });
  if (exists('R2')) {
    for (const r of reqs) {
      if (!want({ sub: r.sub, code: 'R1' }) || model.isSkipped(r.sub, 'R2')) continue;
      const cat = reqCategory(schemas, r.entity.category);
      if (cat?.group === 'functional' && !ucs.some((u) => (u.entity.requirement_ids || []).includes(r.id))) add('warning', w(r, 'R1'), `추적성: 기능 요구사항 ${r.id}를 구현하는 유스케이스가 없습니다`);
    }
  }
  const linked = (t, pred) => ofType(t).some(pred);
  for (const u of ucs) {
    if (!want({ sub: u.sub, code: 'R2' }) && !want({ sub: u.sub, code: 'D1' })) continue;
    if (on(u.sub, 'D1') && !linked('SD', (s) => s.entity.usecase_id === u.id)) add('warning', w(u, 'D1'), `추적성: 유스케이스 ${u.id}의 시퀀스도가 없습니다`);
    if (on(u.sub, 'D2') && !linked('SCR', (s) => s.entity.usecase_id === u.id)) add('warning', w(u, 'D2'), `추적성: 유스케이스 ${u.id}의 화면이 없습니다(화면이 없는 배치성 기능이면 무시)`);
    if (on(u.sub, 'D3') && !linked('CMP', (c) => (c.entity.usecase_ids || []).includes(u.id))) add('warning', w(u, 'D3'), `추적성: 유스케이스 ${u.id}를 담당하는 컴포넌트가 없습니다`);
    if (on(u.sub, 'D10') && !linked('IT', (s) => s.entity.usecase_id === u.id)) add('warning', w(u, 'D10'), `추적성: 유스케이스 ${u.id}의 통합시험 시나리오가 없습니다`);
  }
  if (exists('D7')) {
    for (const r of reqs) {
      const cat = reqCategory(schemas, r.entity.category);
      if (!['PER', 'QUR', 'SER'].includes(cat?.code)) continue;
      const has = ofType('ST').some((s) => s.parent?.requirement_id === r.id);
      if (!has) add('warning', w(r, 'D7'), `추적성: ${r.entity.category} ${r.id}의 시스템시험 시나리오가 없습니다`);
    }
  }
  if (exists('D11')) {
    for (const c of ofType('CMP')) if (!model.isSkipped(c.sub, 'D11') && !linked('UT', (t) => t.entity.component_id === c.id)) add('warning', w(c, 'D11'), `추적성: 컴포넌트 ${c.id}의 단위시험이 없습니다`);
  }
  if (exists('D9')) {
    // DDL이 실행되려면: 키 컬럼 타입, 인덱스·PK가 가리키는 컬럼, FK 대상 컬럼이 모두 있어야 한다
    for (const t of ofType('TB')) {
      const cols = t.entity.columns || [];
      const ids = new Set(cols.map((c) => c.column_id).filter(Boolean));
      for (const c of cols) {
        if ((c.pk === 'Y' || c.fk === 'Y' || c.fk_ref) && !c.type_length) add('error', w(t, 'D9'), `키 컬럼 타입 없음: ${t.id}.${c.column_id} — PK·FK 컬럼은 타입·길이가 있어야 DDL이 만들어진다(일반 관례 타입을 AI 제안으로 쓴다)`);
        if (c.fk_ref && (!/^[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(String(c.fk_ref)) || /\.tbd$/i.test(String(c.fk_ref)))) add('error', w(t, 'D9'), `fk_ref 형식 오류: ${t.id}.${c.column_id} → '${c.fk_ref}' (형식 TB_테이블.컬럼ID — 대상 컬럼을 모르면 공용 설계 지시의 키 컬럼을 쓴다)`);
      }
      for (const ix of t.entity.indexes || []) for (const col of ix.columns || []) if (!ids.has(col)) add('error', w(t, 'D9'), `인덱스 ${ix.id}의 컬럼 '${col}'이 ${t.id}에 없다`);
    }
    for (const e of ofType('ENT')) if (!model.isSkipped(e.sub, 'D9') && !linked('TB', (t) => t.entity.entity_id === e.id)) add('warning', w(e, 'D9'), `추적성: 엔티티 ${e.id}에 대응하는 테이블이 없습니다`);
    // 서브시스템 간 FK 참조(fk_ref: 'TB_이름.컬럼ID')가 실제 테이블·컬럼을 가리키는지
    const tables = ofType('TB');
    for (const t of tables) {
      for (const c of t.entity.columns || []) {
        if (!c.fk_ref) continue;
        const [tb, col] = String(c.fk_ref).split('.');
        const target = tables.find((x) => x.id === tb);
        if (!target) add('warning', w(t, 'D9'), `FK 참조 대상 테이블 없음: ${t.id}.${c.column_id} → ${c.fk_ref}`);
        else if (col && !(target.entity.columns || []).some((x) => x.column_id === col)) add('error', w(t, 'D9'), `FK 참조 대상 컬럼 없음: ${t.id}.${c.column_id} → ${c.fk_ref} (${tb}에 ${col} 없음)`);
        else if (col) {
          const tc = (target.entity.columns || []).find((x) => x.column_id === col);
          // DB는 FK가 대상 테이블의 PK(단일 컬럼)나 유일 인덱스 컬럼을 가리켜야 만들어진다
          const pkCols = (target.entity.columns || []).filter((x) => x.pk === 'Y').map((x) => x.column_id);
          const uniq = (target.entity.indexes || []).some((ix) => ix.unique === 'Y' && (ix.columns || []).length === 1 && ix.columns[0] === col);
          if (!(pkCols.length === 1 && pkCols[0] === col) && !uniq) add('error', w(t, 'D9'), `FK 대상이 키가 아님: ${t.id}.${c.column_id} → ${c.fk_ref} — 대상 테이블의 PK(${pkCols.join(', ') || '없음'})나 유일 인덱스 컬럼을 참조해야 한다`);
          const norm = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');
          if (tc?.type_length && c.type_length && norm(tc.type_length) !== norm(c.type_length)) add('warning', w(t, 'D9'), `FK 타입 불일치: ${t.id}.${c.column_id}(${c.type_length}) → ${c.fk_ref}(${tc.type_length})`);
        }
      }
    }
  }
  for (const c of ofType('CMP')) {
    for (const ic of c.entity.internal_classes || []) {
      const hit = lookup(model, ic.id);
      if (!hit || hit.type !== 'CL') add('warning', w(c, 'D3'), `내부 클래스 ID '${ic.id}'는 설계 클래스 ID(D1)와 일치해야 합니다`);
    }
  }
}
