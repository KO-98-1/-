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

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).filter((k) => k !== '_meta').length === 0);
}
export { isEmpty };

export async function loadModel(ctx) {
  const { p, schemas } = ctx;
  const docs = {};
  const errors = [];
  if (fs.existsSync(p.model)) {
    for (const sub of fs.readdirSync(p.model)) {
      const dir = path.join(p.model, sub);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.yaml')) continue;
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
    errors,
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

export async function saveDoc(ctx, sub, code, data) {
  await writeYaml(modelFile(ctx.p, sub, code), data);
}
