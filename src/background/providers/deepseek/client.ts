import type { ModelInfo, ProviderSession, ResolvedModel } from '../adapter';

// 当前线上公开模型（来源: https://api-docs.deepseek.com/quick_start/pricing，spike 任务 #1 校准）
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-flash', provider: 'deepseek', description: 'V4-Flash — 快速/便宜，默认推荐' },
  { id: 'deepseek-v4-pro', provider: 'deepseek', description: 'V4-Pro — 推理能力更强，含 thinking' },
  { id: 'deepseek-v4-flash-vision-exp', provider: 'deepseek', description: 'V4-Flash-Vision — 视觉模型（图转 token 计费）' },
];

// 内部 web API 模型类型（chat.deepseek.com/api/v0 用 default/expert/vision）
// 公开模型 ID → 内部模型类型 + 字符上限 + 是否开启 thinking
// 字符上限按 ds-free-api 默认（待 spike 实测调整）
const LIMITS = {
  'deepseek-v4-flash': { modelType: 'default' as const, thinking: false, limitChars: 2_621_440 },
  'deepseek-v4-pro': { modelType: 'expert' as const, thinking: true, limitChars: 163_840 },
  'deepseek-v4-flash-vision-exp': { modelType: 'vision' as const, thinking: false, limitChars: 2_621_440 },
};

export function resolveModel(modelId: string): ResolvedModel | null {
  const cfg = LIMITS[modelId as keyof typeof LIMITS];
  if (!cfg) return null;
  return { modelId, ...cfg };
}

export function completionPayload(
  session: ProviderSession,
  prompt: string,
  model: { modelType: 'default' | 'expert' | 'vision'; thinking: boolean },
  overrides?: { thinking?: boolean | null; search?: boolean; reasoningEffort?: 'low' | 'medium' | 'high' | 'max' },
) {
  // thinking: undefined → 用模型默认；null/false 显式关；true 显式开
  const thinkingEnabled = overrides?.thinking === undefined ? model.thinking : Boolean(overrides.thinking);
  const searchEnabled = overrides?.search === undefined ? false : Boolean(overrides.search);
  const payload: Record<string, unknown> = {
    chat_session_id: session.webSessionId,
    parent_message_id: session.parentMessageId ?? null,
    model_type: model.modelType,
    prompt,
    ref_file_ids: [] as string[],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchEnabled,
    preempt: false,
  };
  // reasoning_effort 是 OpenAI 兼容字段；网页端是否生效待实测（多余字段会被忽略）
  if (overrides?.reasoningEffort) payload.reasoning_effort = overrides.reasoningEffort;
  return payload;
}

export // 与 SW 侧 authHeaders/probeHeaders 对齐：DeepSeek 对带 X-Client-* 的请求返回 HTML/401（用户 curl 实测）
function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
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
