// 프로젝트(산출물 작업 폴더) 위치·설정·YAML 입출력
import fs from 'node:fs';
import path from 'node:path';
import { depDefault, SKILL_DIR } from './deps.mjs';

export const WORK_DIRNAME = 'deliverables';

let yamlMod = null;
export async function yaml() {
  if (!yamlMod) yamlMod = await depDefault('js-yaml');
  return yamlMod;
}

export async function readYaml(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const y = await yaml();
  try {
    const v = y.load(text);
    return v ?? fallback;
  } catch (e) {
    const err = new Error(`YAML 구문 오류: ${file}\n${e.message}`);
    err.yamlError = true;
    err.file = file;
    throw err;
  }
}

export async function writeYaml(file, data) {
  const y = await yaml();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = y.dump(data, { lineWidth: 120, noRefs: true, quotingType: '"', forceQuotes: false, sortKeys: false });
  fs.writeFileSync(file, text, 'utf8');
}

// cwd 기준으로 sw-config.yaml 이 있는 작업 폴더를 찾는다.
export function findRoot(start = process.cwd(), explicit = null) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(path.join(p, 'sw-config.yaml'))) return p;
    if (fs.existsSync(path.join(p, WORK_DIRNAME, 'sw-config.yaml'))) return path.join(p, WORK_DIRNAME);
    return p;
  }
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'sw-config.yaml'))) return dir;
    if (fs.existsSync(path.join(dir, WORK_DIRNAME, 'sw-config.yaml'))) return path.join(dir, WORK_DIRNAME);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function paths(root) {
  return {
    root,
    config: path.join(root, 'sw-config.yaml'),
    input: path.join(root, 'input'),
    model: path.join(root, 'model'),
    history: path.join(root, 'model', 'history.yaml'),
    output: path.join(root, 'output'),
    work: path.join(root, '.work'),
    inputs: path.join(root, '.work', 'inputs'),
    inputIndex: path.join(root, '.work', 'inputs', 'index.yaml'),
    prompts: path.join(root, '.work', 'prompts'),
    diagrams: path.join(root, '.work', 'diagrams'),
    reports: path.join(root, 'output', '_검토'),
    state: path.join(root, '.work', 'state.yaml'),
  };
}

function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return over === undefined ? base : over;
}

export async function loadConfig(root) {
  const defaults = await readYaml(path.join(SKILL_DIR, 'templates', 'sw-config.template.yaml'), {});
  const user = await readYaml(path.join(root, 'sw-config.yaml'), {});
  const cfg = deepMerge(defaults, user || {});
  // 서브시스템은 사용자 설정이 있으면 그대로(기본 COM을 덮어씀)
  cfg.subsystems = (user && user.subsystems) || defaults.subsystems || [];
  cfg.subsystems = cfg.subsystems.map((s) => ({ ...s, id: String(s.id).toUpperCase() }));
  return cfg;
}

export async function openProject(opts = {}) {
  const root = findRoot(process.cwd(), opts.root);
  if (!root || !fs.existsSync(path.join(root, 'sw-config.yaml'))) {
    throw new Error("산출물 작업 폴더(sw-config.yaml)를 찾지 못했습니다. 먼저 'swd init'을 실행하세요.");
  }
  const cfg = await loadConfig(root);
  return { root, cfg, p: paths(root) };
}

export function formatDate(cfg, d = null) {
  let date = d;
  if (!date) {
    const fixed = cfg.document?.date;
    date = fixed && fixed !== 'auto' ? new Date(fixed) : new Date();
  }
  if (typeof date === 'string') date = new Date(date);
  if (Number.isNaN(date.getTime())) return String(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return (cfg.document?.date_format || 'YYYY-MM-DD').replace('YYYY', y).replace('MM', m).replace('DD', dd);
}

export function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function subsystemById(cfg, id) {
  if (id === 'SYSTEM') return { id: 'SYSTEM', name: '전체', description: '시스템 공통' };
  return cfg.subsystems.find((s) => s.id === id) || null;
}
