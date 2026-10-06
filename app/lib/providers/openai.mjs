// OpenAI API(API 키) 또는 OpenAI 호환 서버(base URL) — 공식 SDK(openai), Responses API
import OpenAI from 'openai';
import { ProviderError } from './common.mjs';

export function createOpenAI({ apiKey, model, effort = 'high', baseURL } = {}) {
  if (!model) throw new ProviderError('OpenAI 모델 이름을 입력하세요');
  const client = new OpenAI({ apiKey: apiKey || undefined, baseURL: baseURL || undefined, timeout: 30 * 60 * 1000 });
  return {
    id: 'openai',
    label: `OpenAI API · ${model}${baseURL ? ` (${baseURL})` : ''}`,
    model,
    canAgent: false,
    async complete({ system, prompt, maxTokens = 64000, signal }) {
      const params = { model, input: prompt, max_output_tokens: maxTokens };
      if (system) params.instructions = system;
      if (effort && effort !== 'none') params.reasoning = { effort };
      try {
        const stream = client.responses.stream(params, { signal });
        const res = await stream.finalResponse();
        const text = res.output_text || '';
        if (res.status === 'incomplete') {
          const why = res.incomplete_details?.reason;
          if (why === 'content_filter') throw new ProviderError('모델이 내용 필터로 응답을 멈췄습니다');
          throw new ProviderError('출력 한도에 걸려 응답이 잘렸습니다', { truncated: true, text });
        }
        if (res.status === 'failed') throw new ProviderError(`응답 생성 실패: ${res.error?.message || ''}`);
        return { text, usage: res.usage };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err instanceof OpenAI.AuthenticationError) throw new ProviderError('OpenAI API 키가 올바르지 않습니다');
        if (err instanceof OpenAI.NotFoundError) throw new ProviderError(`모델을 찾을 수 없습니다: ${model}`);
        if (err instanceof OpenAI.RateLimitError) throw new ProviderError('요청 한도를 넘었습니다. 잠시 뒤 다시 시도하거나 동시 작업 수를 줄이세요', { retryable: true });
        if (err instanceof OpenAI.BadRequestError) throw new ProviderError(`요청 오류: ${err.message}`);
        if (err instanceof OpenAI.APIError) throw new ProviderError(`OpenAI API 오류 ${err.status ?? ''}: ${err.message}`, { retryable: (err.status ?? 500) >= 500 });
        throw err;
      }
    },
  };
}
