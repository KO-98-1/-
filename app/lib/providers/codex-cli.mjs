// Codex CLI(ChatGPT 로그인 또는 OpenAI 키로 설치된 codex) — 텍스트 생성과 파일 편집 에이전트 둘 다 된다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, ProviderError } from './common.mjs';

export function createCodexCli({ model, effort, bin = 'codex' } = {}) {
  const common = [];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swd-codex-')), 'last.md');
  return {
    id: 'codex-cli',
    label: `Codex CLI${model ? ` · ${model}` : ''}`,
    model: model || '(codex 기본값)',
    canAgent: true,
    // 읽기 전용 샌드박스에서 프롬프트(stdin)에 답만 받는다
    async complete({ system, prompt, signal, cwd, logFile }) {
      const last = tmp();
      const input = system ? `${system}\n\n${prompt}` : prompt;
      const r = await run(bin, ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd || os.tmpdir(), ...common, '-o', last, '-'],
        { input, signal, logFile });
      const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
      if (r.code !== 0 && !text) throw new ProviderError(`codex 실행 실패(종료 코드 ${r.code}): ${(r.err || r.out).slice(-400)}`);
      return { text };
    },
    // 작업 폴더에 쓰기 가능한 샌드박스로 지시를 수행한다(파일 편집·검증 명령 실행)
    async runAgent({ cwd, instruction, signal, logFile }) {
      const last = tmp();
      const r = await run(bin, ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', cwd, ...common, '-o', last, instruction],
        { signal, logFile });
      const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
      if (r.code !== 0 && !text) throw new ProviderError(`codex 실행 실패(종료 코드 ${r.code}): ${(r.err || r.out).slice(-400)}`);
      return { text, code: r.code };
    },
  };
}
