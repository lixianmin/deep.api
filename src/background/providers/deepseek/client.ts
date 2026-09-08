import type { ModelInfo, ProviderSession, ResolvedModel } from '../adapter';

export const API_BASE = 'https://chat.deepseek.com/api/v0';
export const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-chat', provider: 'deepseek', description: 'DeepSeek V3（网页端，thinking 关）' },
  { id: 'deepseek-reasoner', provider: 'deepseek', description: 'DeepSeek R1（网页端，思考过程开放）' },
];

export function resolveModel(modelId: string): ResolvedModel | null {
  if (modelId === 'deepseek-chat') return { modelId, modelType: 'default', thinking: false, limitChars: 2_621_440 };
  if (modelId === 'deepseek-reasoner') return { modelId, modelType: 'expert', thinking: true, limitChars: 163_840 };
  return null;
}

export function completionPayload(session: ProviderSession, prompt: string, model: { modelType: 'default' | 'expert'; thinking: boolean }) {
  return {
    chat_session_id: session.webSessionId,
    parent_message_id: session.parentMessageId ?? null,
    model_type: model.modelType,
    prompt,
    ref_file_ids: [] as string[],
    thinking_enabled: model.thinking,
    search_enabled: false,
    preempt: false,
  };
}

export function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Client-Version': '2.0.0',
    'X-Client-Platform': 'android',
    'X-Client-Locale': 'zh_CN',
    'Content-Type': 'application/json',
  };
}

export function classify(err: unknown): { rateLimited: boolean; authExpired: boolean; unavailable: boolean } {
  const e = err as { status?: number; headers?: Record<string, string> | Headers };
  const status = typeof e?.status === 'number' ? e.status : 0;
  const waf = e?.headers && (
    typeof e.headers === 'object' && !(e.headers instanceof Headers)
      ? Boolean((e.headers as Record<string, string>)['x-amzn-waf-action'])
      : e.headers instanceof Headers
        ? Boolean(e.headers.get?.('x-amzn-waf-action'))
        : false
  );
  return {
    rateLimited: status === 429,
    authExpired: status === 401,
    unavailable: (status === 202 && waf) || status >= 500 || err instanceof TypeError,
  };
}
