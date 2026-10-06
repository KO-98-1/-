// 앱 설정: ~/.config/sw-deliverables/settings.json (API 키가 들어가므로 소유자만 읽기·쓰기)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = process.env.SWD_APP_CONFIG || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'sw-deliverables');
const FILE = path.join(CONFIG_DIR, 'settings.json');

export const DEFAULTS = {
  provider: 'codex-cli',
  model: '',
  effort: 'high',
  baseURL: '',
  keys: { openai: '', anthropic: '' },
  concurrency: 4,
  mode: 'auto', // auto: CLI는 에이전트 방식, API는 텍스트 방식 / agent / chat
  review: false, // 단계마다 멈추고 검토
  projectsDir: path.join(os.homedir(), 'SW산출물'),
};

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...raw, keys: { ...DEFAULTS.keys, ...(raw.keys || {}) } };
  } catch {
    return { ...DEFAULTS, keys: { ...DEFAULTS.keys } };
  }
}

export function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur, ...patch, keys: { ...cur.keys, ...(patch.keys || {}) } };
  // 빈 문자열로 온 키는 '변경 없음'으로 본다(화면에 키를 다시 보내지 않으므로)
  for (const k of Object.keys(next.keys)) if (patch.keys && patch.keys[k] === undefined) next.keys[k] = cur.keys[k];
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* Windows */ }
  return next;
}

// 화면에 보낼 때는 키를 가린다
export function publicSettings(s = loadSettings()) {
  return { ...s, keys: Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v ? `저장됨(…${String(v).slice(-4)})` : ''])) };
}

// 제공자 생성용: 선택한 제공자의 키를 붙인다(환경 변수도 허용)
export function providerSettings(s = loadSettings()) {
  const env = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  return { provider: s.provider, model: s.model, effort: s.effort, baseURL: s.baseURL, apiKey: s.keys[s.provider] || env[s.provider] || '' };
}
