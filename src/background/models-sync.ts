import type { ModelOption } from '../content/models-sync';

/** 2026-09-10（feat/models-sync）：SW 侧 catalog 存储与读取。
 *  spec §3.5（缓存策略：TTL 7 天 + 失败回退）+ §3.6（消息协议）。
 *  fire-and-forget：写失败 / chrome undefined / 读超时一律 silent fallback。 */

export const CATALOG_KEY = 'modelsCatalog';
const TTL_MS = 7 * 24 * 3600 * 1000;

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

/** 2026-09-10（feat/models-sync）：读 catalog；TTL 过期或缺失返回 null。spec §3.5。 */
export async function getModelsCatalog(): Promise<Catalog | null> {
  return await new Promise<Catalog | null>((resolve) => {
    try {
      (globalThis as { chrome?: { storage?: { local?: { get: (k: string, cb: (kv: Record<string, unknown>) => void) => void } } } })
        .chrome?.storage?.local?.get(CATALOG_KEY, (kv) => {
          const raw = kv[CATALOG_KEY] as Catalog | undefined;
          if (!raw || !Array.isArray(raw.models)) return resolve(null);
          if (Date.now() - raw.capturedAt > TTL_MS) return resolve(null);
          resolve(raw);
        });
    } catch { resolve(null); }
  });
}