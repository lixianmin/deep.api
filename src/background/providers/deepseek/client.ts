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
// 默认 thinking=true：与 DeepSeek 官方文档对齐（官方：thinking 默认 enabled，effort 默认 high）
// 调用方传 thinking:false 可显式关
const LIMITS = {
  'deepseek-v4-flash': { modelType: 'default' as const, thinking: true, limitChars: 2_621_440 },
  // 2026-09-09（fix/pro-thinking-default）：Pro 在 chat.deepseek.com/api/v0 上 thinking_enabled=true
  // 会进入「只思考不说话」路径（B-3：sseBytes≈320 仅返 ready+遥测，0 content 0 thinking）。
  // 修：默认 thinking=false 走直答路径。调用方显式传 thinking:true 可覆盖。
  'deepseek-v4-pro': { modelType: 'expert' as const, thinking: false, limitChars: 163_840 },
  'deepseek-v4-flash-vision-exp': { modelType: 'vision' as const, thinking: true, limitChars: 2_621_440 },
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
    // action: null 与上游 reference 项目（zhu1090093659/deepseek-pp）字段对齐——多轮靠服务端按 parent_message_id 关联历史
    action: null,
    preempt: false,
  };
  // reasoning_effort：与 DeepSeek 官方默认一致（high）；调用方可覆盖为 low/medium/max
  // 官方字段在网页 web API 是否生效待实测（多余字段被忽略不会报错）
  const effort = overrides?.reasoningEffort ?? 'high';
  payload.reasoning_effort = effort;
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
