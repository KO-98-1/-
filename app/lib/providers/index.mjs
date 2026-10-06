// 모델 제공자 선택: Codex CLI · Claude Code CLI · OpenAI API · Anthropic API
import { createCodexCli } from './codex-cli.mjs';
import { createClaudeCli } from './claude-cli.mjs';
import { createOpenAI } from './openai.mjs';
import { createAnthropic, DEFAULT_MODEL as ANTHROPIC_DEFAULT } from './anthropic.mjs';
import { which, ProviderError } from './common.mjs';

export { ProviderError };

export const PROVIDERS = [
  { id: 'codex-cli', name: 'Codex CLI', needsKey: false, agent: true, modelHint: '비우면 codex 설정의 기본 모델', check: () => which('codex') },
  { id: 'claude-cli', name: 'Claude Code CLI', needsKey: false, agent: true, modelHint: '비우면 claude 기본 모델 (예: opus, sonnet)', check: () => which('claude') },
  { id: 'openai', name: 'OpenAI API (키)', needsKey: true, agent: false, modelHint: '모델 이름 필수 (OpenAI 호환 서버는 Base URL 입력)', check: () => true },
  { id: 'anthropic', name: 'Anthropic API (키)', needsKey: true, agent: false, modelHint: `비우면 ${ANTHROPIC_DEFAULT}`, check: () => true },
];

export function availability() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, needsKey: p.needsKey, agent: p.agent, modelHint: p.modelHint, available: !!p.check() }));
}

// settings: {provider, model, apiKey, baseURL, effort}
export function createProvider(settings, { kitDir } = {}) {
  const { provider, model, apiKey, baseURL, effort } = settings || {};
  let p;
  switch (provider) {
    case 'codex-cli': p = createCodexCli({ model, effort }); break;
    case 'claude-cli': p = createClaudeCli({ model, effort, kitDir }); break;
    case 'openai': p = createOpenAI({ apiKey, model, effort, baseURL }); break;
    case 'anthropic': p = createAnthropic({ apiKey, model, effort }); break;
    default: throw new ProviderError(`알 수 없는 모델 제공자: ${provider || '(없음)'}`);
  }
  return withRetry(p);
}

// 연결 오류·요청 한도 같은 일시적 오류는 잠시 기다렸다가 다시 시도한다(SDK 자체 재시도 뒤에도 실패한 경우)
const WAITS = [5000, 20000, 60000];
function withRetry(p) {
  const complete = p.complete.bind(p);
  p.complete = async (args) => {
    for (let i = 0; ; i++) {
      try { return await complete(args); } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || i >= WAITS.length || args?.signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, WAITS[i]));
      }
    }
  };
  return p;
}
