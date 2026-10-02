/**
 * ChatGPT provider 模型配置。
 *
 * models 列表来自 `docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md`
 * 配套的实测抓帧——用户在 chatgpt.com 网页里观察到的下拉选项 ID。
 * 不要在这里面写 deepseek-* / 其他 provider 的 ID——单 provider 单一真相源。
 *
 * variant = modelId 本身：MAIN world 把 variant 作为 fetch payload 的 `model` 字段
 * 原样发出（ChatGPT 端点是按 wire 上 `model` 字段路由到具体子模型的）。
 *
 * v1 范围：所有模型都 supportsImages=false / thinking=false——v1 范围守卫由 adapter 层负责
 * 抛 400（不是这里拒绝；这里只是表达「本 provider 在 v1 不暴露这些能力」）。
 */
import type { ModelInfo, ModelVariant, ResolvedModel } from '../adapter';

export const MODELS: ModelInfo[] = [
  { id: 'gpt-5-5', provider: 'chatgpt', description: 'GPT-5.5（默认）' },
  { id: 'gpt-5-6', provider: 'chatgpt', description: 'GPT-5.6（更强推理）' },
  { id: 'gpt-5-3-mini', provider: 'chatgpt', description: 'GPT-5.3 mini（轻量）' },
  { id: 'gpt-5-5-mini', provider: 'chatgpt', description: 'GPT-5.5 mini' },
  { id: 'gpt-5-6-mini', provider: 'chatgpt', description: 'GPT-5.6 mini' },
  { id: 'auto', provider: 'chatgpt', description: 'Auto（让 ChatGPT 自动选模型）' },
];

/** ID → ResolvedModel。gpt-* 与 auto 通过；其它（含 deepseek-*）一律 null。 */
export function resolveModel(modelId: string): ResolvedModel | null {
  if (!MODELS.some((m) => m.id === modelId)) return null;
  return {
    modelId,
    variant: modelId as ModelVariant,
    supportsImages: false,   // v1：不支持图片（adapter 抛 400 拒绝 vision 请求）
    thinking: false,         // v1：不内置 thinking 开关（reasoning 字段被 adapter 接受但忽略）
    // limitChars 取一个远大于实际的数——v1 不在 SW 端做长度校验（实际由 chatgpt.com composer 拦截）；
    // 这里给个保守值避免 router 的 transcript too long 检查误触发。
    limitChars: Number.MAX_SAFE_INTEGER,
  };
}