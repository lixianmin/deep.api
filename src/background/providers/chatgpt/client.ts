/**
 * ChatGPT provider 模型配置。
 *
 * 只暴露一个条目 `chatgpt-web`：模型完全由 ChatGPT 网页决定，桥接不上送模型名。
 * chatgpt.com 页面自己构造请求体，其 `model` 字段是页面写死的；我们注入的 fetch 拦截器
 * 不参与改写。所以这里列多个选项是纯装饰——用户选了哪一档，上游拿到的东西完全一样。
 *
 * 曾经的 6 个 ID（gpt-5-5 / gpt-5-6 / gpt-5-3-mini / gpt-5-5-mini / gpt-5-6-mini / auto）
 * 来自 `/backend-api/models` 全量目录：那是全局目录，与用户账号套餐无关，Free 账号用不到
 * 其中多数。给一排不生效的假选项比不给更糟（用户以为自己能控模型，实际控制不了），故删除。
 *
 * variant 在本 provider 里没有上游含义，仅作占位。
 * 不要在这里面写 deepseek-* / 其他 provider 的 ID——单 provider 单一真相源。
 *
 * v1 范围：supportsImages=false / thinking=false——v1 范围守卫由 adapter 层负责
 * 抛 400（不是这里拒绝；这里只是表达「本 provider 在 v1 不暴露这些能力」）。
 */
import type { ModelInfo, ModelVariant, ResolvedModel } from '../adapter';

export const MODELS: ModelInfo[] = [
  {
    id: 'chatgpt-web',
    provider: 'chatgpt',
    description: 'ChatGPT 网页版（模型由网页按你的账号套餐决定，这里不提供选择）',
  },
];

/** ID → ResolvedModel。只认 `chatgpt-web`；其它一律 null。 */
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