import type { ModelOption } from '../content/models-sync';

/** 2026-09-10（feat/models-sync）：SW 侧 catalog 写入。
 *  spec §3.5（缓存策略：TTL 7 天 + 失败回退）+ §3.6（消息协议）。
 *  读取/合并的最终实现是 `router.loadCatalogFromStorage()` + `router.models()`——
 *  2026-09-11 删除了 `getModelsCatalog()` 这个未接线的重复实现（仅测试引用，TTL 校验也更弱）。 */

export const CATALOG_KEY = 'modelsCatalog';

export interface Catalog {
  source: 'chat.deepseek.com';
  capturedAt: number;
  models: ModelOption[];
}

/** 2026-09-10（feat/models-sync）：fire-and-forget 写 catalog 到 chrome.storage.local。
 *  spec §3.5 失败回退。 */
export function onCatalogUpdate(models: ModelOption[]): void {
  const cat: Catalog = { source: 'chat.deepseek.com', capturedAt: Date.now(), models };
  try {
    (globalThis as { chrome?: { storage?: { local?: { set: (kv: Record<string, unknown>) => void } } } })
      .chrome?.storage?.local?.set({ [CATALOG_KEY]: cat });
  } catch { /* silent fallback per spec §3.5 */ }
}