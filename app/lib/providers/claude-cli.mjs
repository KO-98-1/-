// Claude Code CLI(claude 로그인 또는 ANTHROPIC_API_KEY로 설치된 claude) — 텍스트 생성과 파일 편집 에이전트 둘 다 된다
import { run, ProviderError } from './common.mjs';

export function createClaudeCli({ model, effort, bin = 'claude', kitDir } = {}) {
  const common = ['-p', '--no-session-persistence'];
  if (model) common.push('--model', model);
  if (effort) common.push('--effort', effort);
  return {
    id: 'claude-cli',
    label: `Claude Code CLI${model ? ` · ${model}` : ''}`,
    model: model || '(claude 기본값)',
    canAgent: true,
    // 도구 없이 답만 받는다(프롬프트는 stdin)
    async complete({ system, prompt, signal, cwd, logFile }) {
      const input = system ? `${system}\n\n${prompt}` : prompt;
      const r = await run(bin, [...common, '--output-format', 'text', '--tools', ''], { cwd, input, signal, logFile });
      if (r.code !== 0) throw new ProviderError(`claude 실행 실패(종료 코드 ${r.code}): ${(r.err || r.out).slice(-400)}`);
      return { text: r.out };
    },
    // 작업 폴더의 파일 편집과 검증 명령(node)만 허용해 지시를 수행한다
    async runAgent({ cwd, instruction, signal, logFile }) {
      const args = [...common, '--output-format', 'text', '--tools', 'Read,Write,Edit,Glob,Grep,Bash',
        '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node:*)'];
      if (kitDir) args.push('--add-dir', kitDir);
      args.push('--', instruction);
      const r = await run(bin, args, { cwd, signal, logFile });
      if (r.code !== 0 && !r.out) throw new ProviderError(`claude 실행 실패(종료 코드 ${r.code}): ${r.err.slice(-400)}`);
      return { text: r.out, code: r.code };
    },
  };
}
