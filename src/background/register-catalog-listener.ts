// 2026-09-10（feat/models-sync fix-r1）：spec §3.6 cross-domain message protocol.
// Content script 用 chrome.runtime.sendMessage（不是 bridge port）——SW 必须用
// chrome.runtime.onMessage 接听。bridge 的 port.onMessage 不覆盖这条通道。
// 抽到独立模块是为了让单元测试可以捕获 listener 并直接调用，无需模拟完整 MV3 SW 入口。

import { onCatalogUpdate } from './models-sync';

/** 注册 chrome.runtime.onMessage listener 接听 content script 的 catalog 更新。
 *  应在 SW 顶层调用一次（在 sw.ts 与 chrome.runtime.onInstalled / onStartup 同位）。 */
export function registerCatalogListener(): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      const m = msg as { method?: unknown; models?: unknown } | undefined;
      if (m?.method !== 'models-catalog:update') return;  // 不是给本 SW 的消息，不返回 true
      if (!Array.isArray(m?.models)) {
        sendResponse({ ok: false, error: 'models must be array' });
        return true;
      }
      const models = m.models as { label: string; value?: string }[];
      onCatalogUpdate(models);
      sendResponse({ ok: true });
      return true;  // keep channel open
    } catch {
      // silent fallback per spec §3.5
      try { sendResponse({ ok: false }); } catch { /* ignore */ }
    }
  });
}
