// 제공자 공통: 오류 형식, 자식 프로세스 실행
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export class ProviderError extends Error {
  constructor(message, { truncated = false, retryable = false, text = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.truncated = truncated;
    this.retryable = retryable;
    this.text = text;
  }
}

// 명령 실행: stdin으로 긴 프롬프트를 넘긴다(인자 길이 제한 회피). 로그 파일에 출력 전체를 남긴다.
export function run(cmd, args, { cwd, input = '', logFile = null, signal = null, env = null } = {}) {
  return new Promise((resolve, reject) => {
    // Windows: npm 전역 설치 CLI는 .cmd 래퍼라 셸로만 실행된다 → 경로를 찾아 인자를 따옴표로 감싸 셸 실행
    const win = process.platform === 'win32';
    const resolved = win ? (which(cmd) || cmd) : cmd;
    const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
    const child = win && /\.(cmd|bat)$/i.test(resolved)
      ? spawn(`${q(resolved)} ${args.map(q).join(' ')}`, { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: true })
      : spawn(resolved, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; log?.write(d); });
    child.stderr.on('data', (d) => { err += d; log?.write(d); });
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { log?.end(); reject(e.code === 'ENOENT' ? new ProviderError(`'${cmd}' 명령을 찾을 수 없습니다. 설치했는지 확인하세요`) : e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      log?.end();
      if (signal?.aborted) return reject(new ProviderError('중지됨'));
      resolve({ code, out, err });
    });
    child.stdin.on('error', () => {}); // 프로세스가 먼저 끝나면 EPIPE 무시
    child.stdin.end(input);
  });
}

export function which(cmd) {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = `${d}/${cmd}${e}`;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 없음 */ }
  }
  return null;
}
