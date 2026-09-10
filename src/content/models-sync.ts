/// <reference lib="dom" />
/** 2026-09-10（feat/models-sync）：chat.deepseek.com 模型选择下拉 DOM 抓取。
 *  spec §3.3 多重 selector fallback + label→id best-effort 映射。
 *  2026-09-14（fix/models-v4-retired）：三个 V4 ID 全部 retired，新 ID `deepseek-flash`；
 *  labelToModelId 优先匹配新 ID（fallback 旧 ID 兼容层）。
 *  失败/无 DOM 时一律静默返回 []，不抛错（spec §3.5 失败回退）。 */

export interface ModelOption { label: string; value?: string }

const SELECTOR_CANDIDATES = [
  '[role="listbox"] [role="option"]',
  '.ant-select-item-option',
  'li[role="option"]',
  'select option',
] as const;

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
 *  preflight ruling：使用 bridge 协议的 `method:` 字段。 */
export function sendCatalogUpdate(models: ModelOption[]): void {
  try {
    (globalThis as { chrome?: { runtime?: { sendMessage: (m: unknown) => void } } })
      .chrome?.runtime?.sendMessage({ method: 'models-catalog:update', models });
  } catch { /* silent fallback per spec §3.5 */ }
}

// ---------------------------------------------------------------------------
// 2026-09-14（fix/models-v4-retired）：content script 触发器（top-level side effect）。
// 计划 §3.1 runtime 步骤：wait → waitFor trigger → click → extract → send。
// 仅在 chat.deepseek.com 生效（host guard）；其它页面 no-op。
// ---------------------------------------------------------------------------

const TRIGGER_SELECTOR_CANDIDATES = [
  '[data-testid="model-trigger"]',
  '[aria-label*="model" i][role="combobox"]',
  '[aria-label*="模型" i][role="combobox"]',
  '.ant-select:has(.ant-select-selection-item)',
  'button[aria-haspopup="listbox"]',
] as const;

// 2026-09-14（fix/models-v4-retired）：抽 top-level 副作用到独立 start() 供测试覆写
// interval / max（默认与 spec 一致：poll 15×1s + 3s retry）。
// 测试中可调用 startWith({ pollIntervalMs: 10, pollMaxTries: 5 }) 走快路径。

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_TRIES = 15;
const CLICK_SETTLE_MS = 200;
const RETRY_DELAY_MS = 3000;

export interface StartOptions { pollIntervalMs?: number; pollMaxTries?: number; clickSettleMs?: number; retryDelayMs?: number }

function findTrigger(): HTMLElement | null {
  for (const sel of TRIGGER_SELECTOR_CANDIDATES) {
    const el = document.querySelector(sel);
    if (el) return el as HTMLElement;
  }
  return null;
}

/** 打开下拉 → 等渲染 → 抽 options → 关闭 → 推 SW。失败一律静默。 */
async function captureOnce(): Promise<boolean> {
  const trigger = findTrigger();
  if (!trigger) return false;
  try { trigger.click(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
  const opts = await extractModelOptions();
  // 关闭下拉：Escape 键（Ant Design / ARIA combobox 通用）
  try {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.click();
  } catch { /* ignore */ }
  if (opts.length === 0) return false;
  sendCatalogUpdate(opts);
  return true;
}

function isTargetHost(): boolean {
  try {
    const h = location.hostname;
    return h === 'chat.deepseek.com' || h.endsWith('.deepseek.com');
  } catch { return false; }
}

function start(): void {
  if (!isTargetHost()) return;
  // 2026-09-14（fix/models-v4-retired）：允许测试走快路径。默认不快——发布不需快。
  const opts: Required<StartOptions> = {
    pollIntervalMs: POLL_INTERVAL_MS,
    pollMaxTries: POLL_MAX_TRIES,
    clickSettleMs: CLICK_SETTLE_MS,
    retryDelayMs: RETRY_DELAY_MS,
  };
  startWith(opts);
}

/** 2026-09-14（fix/models-v4-retired）：start() 的可定制版本——测试可传 fast interval/tries。
 *  若 trigger 不在，重试 RETRY_DELAY_MS 后再 captureOnce 一次。 */
export function startWith(opts: StartOptions): void {
  if (!isTargetHost()) return;
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxTries = opts.pollMaxTries ?? POLL_MAX_TRIES;
  const settle = opts.clickSettleMs ?? CLICK_SETTLE_MS;
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;

  const pollOnce = async (): Promise<boolean> => {
    for (let i = 0; i < maxTries; i++) {
      if (await captureOnceSettle(settle)) return true;
      await new Promise((r) => setTimeout(r, interval));
    }
    await new Promise((r) => setTimeout(r, retryDelay));
    return await captureOnceSettle(settle);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void pollOnce(); }, { once: true });
  } else {
    void pollOnce();
  }

  // 2026-09-14（fix/models-v4-retired）：click listener 仅在生产模式注册（避免测试污染）。
  // 测试在 beforeEach 重置 document 时不会清旧 listener，导致 stale poll 阻塞后续测试。
  if ((globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST !== true) {
    document.addEventListener('click', () => {
      setTimeout(() => { void pollOnce(); }, settle);
    }, true);
  }
}

async function captureOnceSettle(settleMs: number): Promise<boolean> {
  const trigger = findTrigger();
  if (!trigger) return false;
  try { trigger.click(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, settleMs));
  const opts = await extractModelOptions();
  try {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.click();
  } catch { /* ignore */ }
  if (opts.length === 0) return false;
  sendCatalogUpdate(opts);
  return true;
}

// 2026-09-14（fix/models-v4-retired）：发布副作用——模块被加载时启动 trigger。
// 测试可设 (globalThis as any).__MODELS_SYNC_TEST = true 跳过发布副作用。
if ((globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST !== true) {
  if (typeof chrome !== 'undefined' || (typeof location !== 'undefined')) {
    start();
  }
}
