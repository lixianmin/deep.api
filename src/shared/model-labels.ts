/** 2026-10-01（refactor/provider-boundary-cleanup）：label → model ID 的纯字符串映射，不碰 DOM。
 *  为何独立于 content script：background/router.ts 需要它，但 background layer 不应反向依赖
 *  content script（SW 是 extension 的根，content script 是注入的叶子，倒向依赖会破坏边界）。
 *  抽成纯模块后，两侧均可 import，而 models-sync.ts 自身也继续用同一份实现。 */

const LABEL_PATTERNS: Array<{ re: RegExp; id: string }> = [
  { re: /^(default|deepseek(\s+v4[\s\-_.]*1[\s\-_.]*)?\s+flash|v4[\s\-_.]*1[\s\-_.]*\s+flash)$/i, id: 'deepseek-flash' },
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
