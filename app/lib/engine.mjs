// 킷 엔진(스키마·검증·지시서·렌더러) 연결: 앱은 가이드 양식 처리를 모두 킷의 swd 엔진에 맡긴다
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..');
export const KIT_SKILL = process.env.SWD_SKILL_DIR || path.resolve(APP_DIR, '..', '.claude', 'skills', 'sw-deliverables');
export const SWD = path.join(KIT_SKILL, 'scripts', 'swd.mjs');

const libCache = new Map();
export async function lib(name) {
  if (!libCache.has(name)) libCache.set(name, await import(pathToFileURL(path.join(KIT_SKILL, 'scripts', 'lib', name)).href));
  return libCache.get(name);
}

export async function context(root) {
  const { openProject } = await lib('project.mjs');
  const { loadSchemas } = await lib('schema.mjs');
  const { root: r, cfg, p } = await openProject({ root });
  return { root: r, cfg, p, schemas: await loadSchemas() };
}

export async function loadModel(ctx) {
  const { loadModel: lm } = await lib('model.mjs');
  return lm(ctx);
}

// swd 명령을 자식 프로세스로 실행하고 출력 줄을 onLine으로 흘려보낸다
export function swd(args, { root, onLine = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SWD, ...args, ...(root ? ['--root', root] : [])], { cwd: root || process.cwd() });
    let out = '';
    let buf = '';
    const feed = (d) => {
      out += d;
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) onLine(buf);
      resolve({ code, out });
    });
  });
}

export async function validate(ctx, model, opts = {}) {
  const { validate: v } = await lib('validate.mjs');
  return v(ctx, model, opts);
}

export async function readYamlFile(file, fallback = null) {
  const { readYaml } = await lib('project.mjs');
  return readYaml(file, fallback);
}

export async function writeYamlFile(file, data) {
  const { writeYaml } = await lib('project.mjs');
  return writeYaml(file, data);
}

export async function parseYaml(text) {
  const { yaml } = await lib('project.mjs');
  return (await yaml()).load(text);
}

// 정규화된 입력 목록과 본문: [{id, kind, title, date, file, content}]
export async function loadInputs(ctx) {
  const { loadInputIndex } = await lib('ingest.mjs');
  const idx = await loadInputIndex(ctx.p);
  const out = [];
  for (const x of idx.values()) {
    if (x.status !== 'ok') continue;
    const file = path.join(ctx.p.root, x.text);
    if (!fs.existsSync(file)) continue;
    out.push({ id: x.id, kind: x.kind, title: x.title, date: x.date, file: x.text, content: fs.readFileSync(file, 'utf8').replace(/\r/g, '') });
  }
  return out;
}

export function numbered(content) {
  return content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
}
