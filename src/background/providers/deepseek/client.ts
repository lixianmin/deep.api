import type { ModelInfo, ProviderSession, ResolvedModel } from '../adapter';

// 2026-09-14（fix/models-v4-retired）：V4 三个 ID（flash / pro / vision-exp）官方
// 9/14 12:00 起全部 retired，统一为 V4.1 Flash 新 ID `deepseek-flash`（UI
// 显示 "default"）。`MODELS` 是模型列表的单一真相源——不要在别处另写一份。
// 2026-09-14（fix/accept-v4-flash-alias）：`deepseek-v4-flash` 只在 `LIMITS` 里保留
// 兼容解析（旧下游仍发此 ID），**不**列进 `MODELS`。
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', provider: 'deepseek', description: 'DeepSeek V4.1 Flash — 快速/便宜，统一默认模型' },
];

export interface MergedModel {
  id: string;
  description: string;
  modelType: 'default' | 'expert' | 'vision';
  supportsImages: boolean;
  thinking: boolean;
  limitChars: number;
  capturedAt?: number;
  source?: string;
}

// 内部 web API 模型类型（chat.deepseek.com/api/v0 用 default/expert/vision）
// 公开模型 ID → 内部模型类型 + 是否支持图片输入 + 字符上限 + 是否开启 thinking
// 2026-09-14（fix/models-v4-retired）：V4 三个 chat ID（flash / pro / vision-exp）官方
// 9/14 12:00 起 retired，统一为 V4.1 Flash 新 ID `deepseek-flash`。
// 但 vision-exp 实际是独立实验模型，不在本次统一范围内（DeepSeek changelog
// 只提 3 个 chat 入口；vision 是 file upload side-model）—— 保留兼容层让 vision 继续可用。
// 2026-09-10（fix/vision-model-type）：图片能力与 wire `model_type` 解耦。网页端带图请求用
// `model_type:"default"` + `ref_file_ids`（用户抓包实证），而 `model_type:"vision"` 会路由到
// 用 DSML（`<|dsml|tool_calls>`）工具调用格式的 vision 变体——下游按标准 `<tool_calls>` 解析
// 会失败。所以 chat 模型一律发 `default`，图片支持改由 `supportsImages` 独立表达。
const LIMITS = {
  'deepseek-flash': { modelType: 'default' as const, supportsImages: true, thinking: true, limitChars: 2_621_440 },
  // 2026-09-14（fix/accept-v4-flash-alias）：`fix/models-v4-retired` 误把旧 chat ID 从
  // `resolveModel` 一并删掉，导致仍发 `deepseek-v4-flash` 的下游被 router 拦成 400
  // `unknown model`。DeepSeek API 兼容层仍接受该 ID（路由到 V4.1 Flash），故恢复解析。
  // 配置与 `deepseek-flash` 完全一致（同一底层模型，含图片支持），保持别名语义：
  // 两者相互切换时 mapper 的 modelType 相同 → 仍走 incremental，不触发 rebuild。
  'deepseek-v4-flash': { modelType: 'default' as const, supportsImages: true, thinking: true, limitChars: 2_621_440 },
  // 2026-09-10（fix/vision-model-type）：vision-exp 是唯一仍需 `model_type:"vision"` 的
  // 独立实验模型；保留兼容层，如后续 retire 再删。
  'deepseek-v4-flash-vision-exp': { modelType: 'vision' as const, supportsImages: true, thinking: true, limitChars: 2_621_440 },
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
  /** 2026-09-09（feat/vision-multimodal）：vision 模型上传后的 file_id 列表，传 ref_file_ids。 */
  refFileIds?: string[],
) {
  // thinking: undefined → 用模型默认；null/false 显式关；true 显式开
  const thinkingEnabled = overrides?.thinking === undefined ? model.thinking : Boolean(overrides.thinking);
  const searchEnabled = overrides?.search === undefined ? false : Boolean(overrides.search);
  const payload: Record<string, unknown> = {
    chat_session_id: session.webSessionId,
    parent_message_id: session.parentMessageId ?? null,
    model_type: model.modelType,
    prompt,
    ref_file_ids: refFileIds && refFileIds.length > 0 ? refFileIds : [],
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
