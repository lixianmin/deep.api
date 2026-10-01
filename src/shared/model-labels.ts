/** 2026-10-01（refactor/provider-boundary-cleanup）：label → model ID 的纯字符串映射，不碰 DOM。
 *  为何独立于 content script：background/router.ts 需要它，但 background layer 不应反向依赖
 *  content script（SW 是 extension 的根，content script 是注入的叶子，倒向依赖会破坏边界）。
 *  抽成纯模块后，两侧均可 import，而 models-sync.ts 自身也继续用同一份实现。 */

/** 2026-09-14（fix/models-v4-retired）：按 V4.1 Flash 统一后调整。
 *  优先匹配新 ID `deepseek-flash`（覆盖 "default" / "DeepSeek V4.1 Flash" 等显示文案）；
 *  兼容旧三个 V4 ID（retired 兼容层仍 accept，但不被选为新内容——这里仅当明确出现
 *  "v4" + "pro/vision/flash" 独立片段时仍认得，留作安全网）。
 *  @internal 纯字符串映射，不碰 DOM，供 content/background 两侧 import。 */
export interface ModelOption { label: string; value?: string }

// 2026-09-14（fix/models-v4-retired）：按 V4.1 Flash 统一后调整。
// 优先匹配新 ID `deepseek-flash`（覆盖 "default" / "DeepSeek V4.1 Flash" 等显示文案）；
// 兼容旧三个 V4 ID（retired 兼容层仍 accept，但不被选为新内容——这里仅当明确出现
// "v4" + "pro/vision/flash" 独立片段时仍认得，留作安全网）。
const LABEL_PATTERNS: Array<{ re: RegExp; id: string }> = [
  // 新模型（V4.1 Flash 统一）："default" / "DeepSeek V4.1 Flash" / "V4.1 Flash" / "DeepSeek Flash" / "DeepSeek"
  { re: /^(default|deepseek(\s+v4[\s\-_.]*1[\s\-_.]*)?\s+flash|v4[\s\-_.]*1[\s\-_.]*\s+flash)$/i, id: 'deepseek-flash' },
  // 旧 ID 兼容（仅当 label 明确带 v4-pro / v4-flash-vision-exp 字样时认得，否则走默认 flash）
  { re: /deepseek\s*v4\s*flash\s*vision\s*exp(eriment(al)?)?/i, id: 'deepseek-v4-flash-vision-exp' },
  { re: /deepseek\s*v4\s*pro/i, id: 'deepseek-v4-pro' },
  { re: /deepseek\s*v4\s*flash/i, id: 'deepseek-flash' },
];

export function labelToModelId(label: string): string | null {
  const t = (label || '').trim();
  if (!t) return null;
  for (const { re, id } of LABEL_PATTERNS) {
    if (re.test(t)) return id;
  }
  return null;
}
