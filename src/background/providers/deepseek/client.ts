import type { ModelInfo, ProviderSession, ResolvedModel } from '../adapter';
import { labelToModelId, type ModelOption } from '../../../content/models-sync';

// 2026-09-14（fix/models-v4-retired）：V4 三个 ID（flash / pro / vision-exp）官方
// 9/14 12:00 起全部 retired，统一为 V4.1 Flash 新 ID `deepseek-flash`（UI
// 显示 "default"）。`MODELS` 是单一真相源——不要在别处另写一份。
// 旧 ID 仍被 API 兼容层接受（路由到 V4.1 Flash），但本常量不再导出它们。
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', provider: 'deepseek', description: 'DeepSeek V4.1 Flash — 快速/便宜，统一默认模型' },
];

export interface MergedModel {
  id: string;
  description: string;
  modelType: 'default' | 'expert' | 'vision';
  thinking: boolean;
  limitChars: number;
  capturedAt?: number;
  source?: string;
}

/** 2026-09-10（feat/models-sync）：catalog 与 hardcoded 合并——id 匹配则覆盖
 *  description + 加 capturedAt / source；不删 hardcoded，不加新 id（spec §6 不做）。
 *  catalog 为 null → 返回 hardcoded 副本（不共享引用）。 */
export function mergeWithHardcoded(
  catalog: { capturedAt: number; models: ModelOption[] } | null,
  hardcoded: MergedModel[],
): MergedModel[] {
  if (!catalog) return hardcoded.map((m) => ({ ...m }));
  const byLabel: Map<string, string> = new Map();
  for (const o of catalog.models) {
    const id = labelToModelId(o.label);
    if (id) byLabel.set(id, o.label);
  }
  return hardcoded.map((m) =>
    byLabel.has(m.id)
      ? { ...m, description: byLabel.get(m.id)!, capturedAt: catalog.capturedAt, source: 'chat.deepseek.com' }
      : { ...m, description: m.id },
  );
}

// 内部 web API 模型类型（chat.deepseek.com/api/v0 用 default/expert/vision）
// 公开模型 ID → 内部模型类型 + 字符上限 + 是否开启 thinking
// 2026-09-14（fix/models-v4-retired）：V4 三个 chat ID（flash / pro / vision-exp）官方
// 9/14 12:00 起 retired，统一为 V4.1 Flash 新 ID `deepseek-flash`。
// 但 vision-exp 实际是独立实验模型，不在本次统一范围内（DeepSeek changelog
// 只提 3 个 chat 入口；vision 是 file upload side-model）—— 保留兼容层让 vision 继续可用。
// 如 vision-exp 后续也 retire，再删。
const LIMITS = {
  'deepseek-flash': { modelType: 'default' as const, thinking: true, limitChars: 2_621_440 },
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
