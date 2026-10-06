// Anthropic API(API 키) — 공식 SDK(@anthropic-ai/sdk)
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from './common.mjs';

export const DEFAULT_MODEL = 'claude-opus-5';
// 서버 측 거절 대체(fallbacks: "default")를 켜는 모델
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
// adaptive thinking·effort를 받지 않는 구형 모델
const LEGACY = /haiku|claude-(3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

export function createAnthropic({ apiKey, model, effort = 'high' } = {}) {
  const useModel = model || DEFAULT_MODEL;
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return {
    id: 'anthropic',
    label: `Anthropic API · ${useModel}`,
    model: useModel,
    canAgent: false,
    async complete({ system, prompt, maxTokens = 64000, signal }) {
      const params = {
        model: useModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      };
      // 같은 지시(system)를 여러 번 보내므로 캐시를 건다
      if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      if (!LEGACY.test(useModel)) {
        params.thinking = { type: 'adaptive' };
        if (effort) params.output_config = { effort };
      }
      try {
        const stream = FALLBACK_MODELS.has(useModel)
          ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
          : client.messages.stream(params, { signal });
        const msg = await stream.finalMessage();
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (msg.stop_reason === 'refusal') throw new ProviderError(`모델이 요청을 거절했습니다 (${msg.stop_details?.category || '분류 없음'})`);
        if (msg.stop_reason === 'max_tokens') throw new ProviderError('출력 한도(max_tokens)에 걸려 응답이 잘렸습니다', { truncated: true, text });
        return { text, usage: msg.usage };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err instanceof Anthropic.AuthenticationError) throw new ProviderError('Anthropic API 키가 올바르지 않습니다');
        if (err instanceof Anthropic.PermissionDeniedError) throw new ProviderError(`이 API 키로는 ${useModel} 모델을 쓸 수 없습니다`);
        if (err instanceof Anthropic.NotFoundError) throw new ProviderError(`모델을 찾을 수 없습니다: ${useModel}`);
        if (err instanceof Anthropic.RateLimitError) throw new ProviderError('요청 한도를 넘었습니다. 잠시 뒤 다시 시도하거나 동시 작업 수를 줄이세요', { retryable: true });
        if (err instanceof Anthropic.BadRequestError) throw new ProviderError(`요청 오류: ${err.message}`);
        if (err instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API 오류 ${err.status ?? ''}: ${err.message}`, { retryable: (err.status ?? 500) >= 500 });
        throw err;
      }
    },
  };
}
