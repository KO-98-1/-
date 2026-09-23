// 의존성 로더: 스킬 폴더의 node_modules → 사용자 공유 런타임 순서로 찾는다.
// 런타임(약 460MB, 대부분 Mermaid)은 사용자당 한 번만 설치해 여러 프로젝트가 공유한다.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = path.resolve(SCRIPTS_DIR, '..');

export function runtimeDir() {
  if (process.env.SWD_RUNTIME) return process.env.SWD_RUNTIME;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'sw-deliverables', 'runtime');
}

function candidates() {
  return [path.join(SCRIPTS_DIR, 'package.json'), path.join(runtimeDir(), 'package.json')];
}

export function resolveDep(name) {
  for (const base of candidates()) {
    if (!fs.existsSync(path.join(path.dirname(base), 'node_modules'))) continue;
    try {
      return createRequire(base).resolve(name);
    } catch { /* 다음 후보 */ }
  }
  return null;
}

const cache = new Map();
export async function dep(name) {
  if (cache.has(name)) return cache.get(name);
  const p = resolveDep(name);
  if (!p) {
    throw new Error(`의존성 '${name}'을(를) 찾을 수 없습니다. 먼저 'node swd.mjs setup'을 실행하세요.`);
  }
  const mod = await import(pathToFileURL(p).href);
  cache.set(name, mod);
  return mod;
}

export async function depDefault(name) {
  const mod = await dep(name);
  return mod.default ?? mod;
}

// CommonJS 모듈을 그대로 require 해야 하는 경우(cfb 등)
export function requireDep(name) {
  const p = resolveDep(name);
  if (!p) throw new Error(`의존성 '${name}'을(를) 찾을 수 없습니다. 'node swd.mjs setup'을 실행하세요.`);
  return createRequire(p)(p);
}

export function findBrowser() {
  if (process.env.SWD_BROWSER && fs.existsSync(process.env.SWD_BROWSER)) return process.env.SWD_BROWSER;
  const pf = process.env.ProgramFiles || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ];
  return list.find((p) => p && fs.existsSync(p)) || null;
}
