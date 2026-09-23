// 가이드 스키마 로더: schema/*.yaml → 산출물 정의(필드·레이아웃)
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './deps.mjs';
import { readYaml } from './project.mjs';

export const SCHEMA_DIR = path.join(SKILL_DIR, 'schema');
export const ORDER = ['R1', 'R2', 'CC', 'GL', 'R3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12',
  'I1', 'I2', 'I3', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const PHASES = ['analysis', 'design', 'implementation', 'test'];
export const PHASE_NAMES = { analysis: '분석', design: '설계', implementation: '구현', test: '시험' };

let cached = null;

export async function loadSchemas() {
  if (cached) return cached;
  const common = await readYaml(path.join(SCHEMA_DIR, '_common.yaml'), {});
  const raw = {};
  for (const f of fs.readdirSync(SCHEMA_DIR)) {
    if (!f.endsWith('.yaml') || f.startsWith('_')) continue;
    const s = await readYaml(path.join(SCHEMA_DIR, f));
    raw[s.code] = s;
  }
  const resolved = {};
  const resolve = (code) => {
    if (resolved[code]) return resolved[code];
    const s = raw[code];
    if (!s) throw new Error(`알 수 없는 산출물 코드: ${code}`);
    let out = { ...s };
    if (s.extends) {
      const base = resolve(s.extends);
      out = { ...base, ...s, entities: s.entities || base.entities, layout: s.layout || base.layout };
    }
    out.phase_name = PHASE_NAMES[out.phase];
    out.label = out.label || out.code;
    out.title = out.title || out.name;
    resolved[code] = out;
    return out;
  };
  for (const code of Object.keys(raw)) resolve(code);
  const list = ORDER.filter((c) => resolved[c]).map((c) => resolved[c]);
  cached = { common, byCode: resolved, list };
  return cached;
}

export function activeDeliverables(schemas, cfg) {
  const skip = new Set((cfg.deliverables?.skip || []).map(String));
  const optional = new Set((cfg.deliverables?.optional || []).map(String));
  return schemas.list.filter((s) => !skip.has(s.code) && (!s.optional || optional.has(s.code)));
}

export function deliverablesForPhase(schemas, cfg, phase) {
  return activeDeliverables(schemas, cfg).filter((s) => s.phase === phase);
}

// 산출물 코드 목록 파싱: "R1,R2" 또는 단계명
export function parseDocs(schemas, cfg, spec) {
  if (!spec) return activeDeliverables(schemas, cfg).map((s) => s.code);
  const phaseAlias = { 분석: 'analysis', 설계: 'design', 구현: 'implementation', 시험: 'test' };
  const out = [];
  for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const ph = phaseAlias[part] || (PHASES.includes(part) ? part : null);
    if (ph) out.push(...deliverablesForPhase(schemas, cfg, ph).map((s) => s.code));
    else if (schemas.byCode[part.toUpperCase()]) out.push(part.toUpperCase());
    else throw new Error(`알 수 없는 산출물/단계: ${part}`);
  }
  return [...new Set(out)];
}

// 요구사항 구분 → 분류코드/그룹
export function reqCategory(schemas, name) {
  return (schemas.common.requirement_categories || []).find((c) => c.name === name) || null;
}
