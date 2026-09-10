/// <reference lib="dom" />
/** 2026-09-10（feat/models-sync）：chat.deepseek.com 模型选择下拉 DOM 抓取。
 *  spec §3.3 多重 selector fallback + label→id best-effort 映射。
 *  失败/无 DOM 时一律静默返回 []，不抛错（spec §3.5 失败回退）。 */

export interface ModelOption { label: string; value?: string }

const SELECTOR_CANDIDATES = [
  '[role="listbox"] [role="option"]',
  '.ant-select-item-option',
  'li[role="option"]',
  'select option',
] as const;

const LABEL_PATTERNS: Array<{ re: RegExp; id: string }> = [
  { re: /deepseek\s*v4\s*flash\s*vision\s*exp(eriment(al)?)?/i, id: 'deepseek-v4-flash-vision-exp' },
  { re: /deepseek\s*v4\s*pro/i, id: 'deepseek-v4-pro' },
  { re: /deepseek\s*v4\s*flash/i, id: 'deepseek-v4-flash' },
];

export function labelToModelId(label: string): string | null {
  const t = (label || '').trim();
  if (!t) return null;
  for (const { re, id } of LABEL_PATTERNS) {
    if (re.test(t)) return id;
  }
  return null;
}

export async function extractModelOptions(): Promise<ModelOption[]> {
  for (const sel of SELECTOR_CANDIDATES) {
    const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    if (nodes.length === 0) continue;
    return nodes
      .map((n) => ({ label: (n.textContent || '').trim() }))
      .filter((o) => o.label.length > 0);
  }
  return [];
}

/** 2026-09-10（feat/models-sync）：fire-and-forget 推 catalog 到 SW。
 *  spec §3.6 跨域消息协议。失败一律吞（spec §3.5 失败回退）。
 *  preflight ruling：使用 bridge 协议的 `method:` 字段（与 src/shared/protocol.ts
 *  isBridgeRequest + src/background/sw.ts port.onMessage 一致；不是 `kind:`）。 */
export function sendCatalogUpdate(models: ModelOption[]): void {
  try {
    (globalThis as { chrome?: { runtime?: { sendMessage: (m: unknown) => void } } })
      .chrome?.runtime?.sendMessage({ method: 'models-catalog:update', models });
  } catch { /* silent fallback per spec §3.5 */ }
}