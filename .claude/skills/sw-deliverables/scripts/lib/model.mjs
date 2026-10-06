// 프로젝트 모델(model/<SUB>/<CODE>.yaml) 로드와 전역 ID 인덱스
import fs from 'node:fs';
import path from 'node:path';
import { readYaml, writeYaml } from './project.mjs';

export function docKey(sub, code) {
  return `${sub}:${code}`;
}

export function modelFile(p, sub, code) {
  return path.join(p.model, sub, `${code}.yaml`);
}

// 생략 기록: 가이드 작성 목적의 핵심 내용을 쓸 근거가 없어 만들지 않은 산출물 → {코드: {reason, needs, sources}}
export const SKIP_FILE = '_skip.yaml';
export function skipFile(p, sub) {
  return path.join(p.model, sub, SKIP_FILE);
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).filter((k) => k !== '_meta').length === 0);
}
export { isEmpty };

export async function loadModel(ctx) {
  const { p, schemas } = ctx;
  const docs = {};
  const skipped = {};
  const errors = [];
  if (fs.existsSync(p.model)) {
    for (const sub of fs.readdirSync(p.model)) {
      const dir = path.join(p.model, sub);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.yaml')) continue;
        if (f === SKIP_FILE) {
          try {
            skipped[sub] = (await readYaml(path.join(dir, f), {})) || {};
          } catch (e) {
            errors.push({ file: path.join(dir, f), message: e.message });
          }
          continue;
        }
        const code = f.replace(/\.yaml$/, '').toUpperCase();
        if (!schemas.byCode[code]) continue;
        const file = path.join(dir, f);
        try {
          const data = (await readYaml(file, {})) || {};
          docs[docKey(sub, code)] = { sub, code, file, data };
        } catch (e) {
          errors.push({ file, message: e.message });
        }
      }
    }
  }
  const model = {
    docs,
    skipped,
    errors,
    isSkipped(sub, code) {
      return !!skipped[sub]?.[code];
    },
    get(sub, code) {
      return docs[docKey(sub, code)]?.data || {};
    },
    has(sub, code) {
      return !!docs[docKey(sub, code)];
    },
    subsOf(code) {
      return Object.values(docs).filter((d) => d.code === code).map((d) => d.sub);
    },
  };
  buildIndex(ctx, model);
  return model;
}

// 전역 ID 인덱스. 파생 산출물(I2·T1·T2·T7)은 원본과 같은 ID를 쓰므로 정의로 보지 않는다.
export function buildIndex(ctx, model) {
  const { schemas } = ctx;
  const index = new Map();
  const dupes = [];
  const add = (id, info) => {
    if (id === undefined || id === null || id === '') return;
    const key = String(id);
    if (index.has(key)) {
      const prev = index.get(key);
      dupes.push({ id: key, a: `${prev.sub}:${prev.code}`, b: `${info.sub}:${info.code}` });
      return;
    }
    index.set(key, info);
  };
  const walk = (fieldsSpec, obj, info, pathStr) => {
    if (!fieldsSpec || !obj || typeof obj !== 'object') return;
    for (const [fname, fspec] of Object.entries(fieldsSpec)) {
      if (!fspec || fspec.type !== 'object-list' || !Array.isArray(obj[fname])) continue;
      obj[fname].forEach((child, i) => {
        const cpath = `${pathStr}.${fname}[${i}]`;
        const idType = fspec.fields?.id?.id_type;
        if (idType && child && child.id) add(child.id, { ...info, type: idType, entity: child, parent: obj, path: cpath });
        walk(fspec.fields, child, info, cpath);
      });
    }
  };
  for (const d of Object.values(model.docs)) {
    const s = schemas.byCode[d.code];
    if (!s || s.derived_from) continue;
    for (const [coll, espec] of Object.entries(s.entities || {})) {
      const list = d.data?.[coll];
      if (!Array.isArray(list)) continue;
      list.forEach((item, i) => {
        const info = { sub: d.sub, code: d.code, collection: coll };
        if (espec.id_type && !espec.id_is_ref && item && item.id) {
          add(item.id, { ...info, type: espec.id_type, entity: item, path: `${coll}[${i}]` });
        }
        walk(espec.fields, item, info, `${coll}[${i}]`);
      });
    }
  }
  model.index = index;
  model.dupes = dupes;
  return index;
}

export function lookup(model, id) {
  if (id === undefined || id === null) return null;
  return model.index.get(String(id)) || null;
}

export function nameOf(model, id) {
  const hit = lookup(model, id);
  return hit?.entity?.name || null;
}

// 모든 서브시스템의 특정 컬렉션을 모아 반환 [{sub, item}]
export function collectAll(model, code, coll) {
  const out = [];
  for (const d of Object.values(model.docs)) {
    if (d.code !== code) continue;
    for (const item of d.data?.[coll] || []) out.push({ sub: d.sub, item });
  }
  return out;
}

// 결과서(results: true)에 실제 수행 결과가 하나라도 있는지.
// 가이드상 결과서는 '수행한 시험 결과를 기술'하므로 결과가 없으면 문서를 만들지 않는다(뼈대 모델만 유지).
export function hasResults(schema, data) {
  const walk = (fields, obj) => {
    if (!obj || typeof obj !== 'object') return false;
    for (const [k, f] of Object.entries(fields || {})) {
      if (!f || typeof f !== 'object') continue;
      const v = obj[k];
      if (f.result && !isEmpty(v)) return true;
      if (f.fields && Array.isArray(v) && v.some((c) => walk(f.fields, c))) return true;
      if (f.fields && v && typeof v === 'object' && !Array.isArray(v) && walk(f.fields, v)) return true;
    }
    return false;
  };
  return Object.entries(schema.entities || {}).some(([coll, e]) => {
    const v = data?.[coll];
    return Array.isArray(v) ? v.some((it) => walk(e.fields, it)) : walk(e.fields, v);
  });
}

// 문서를 만들지 않는 이유(없으면 null): 생략 기록 또는 결과 없는 결과서
export function unrenderedReason(ctx, model, sub, code) {
  if (model.isSkipped(sub, code)) return `생략(단서 부족) — ${model.skipped[sub][code]?.reason || '사유 없음'}`;
  const s = ctx.schemas.byCode[code];
  if (s?.derived_from && s.results && model.has(sub, code) && !hasResults(s, model.get(sub, code))) {
    return '실제 수행 결과가 입력되지 않음 → 결과 입력 후 생성';
  }
  return null;
}

export async function saveDoc(ctx, sub, code, data) {
  await writeYaml(modelFile(ctx.p, sub, code), data);
}
