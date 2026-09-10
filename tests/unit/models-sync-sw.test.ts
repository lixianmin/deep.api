import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onCatalogUpdate, getModelsCatalog, CATALOG_KEY } from '../../src/background/models-sync';

const store = new Map<string, unknown>();
let chromeRef: { storage?: { local?: { set: (kv: Record<string, unknown>) => void; get: (k: string, cb: (kv: Record<string, unknown>) => void) => void } } } | undefined;
function setChromeRef() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        set: (kv: Record<string, unknown>) => { for (const [k, v] of Object.entries(kv)) store.set(k, v); },
        get: (k: string, cb: (kv: Record<string, unknown>) => void) => { cb({ [k]: store.get(k) }); },
      },
    },
  });
}
beforeEach(() => { store.clear(); setChromeRef(); });

describe('onCatalogUpdate', () => {
  it('writes catalog to chrome.storage.local with source + capturedAt', () => {
    onCatalogUpdate([{ label: 'DeepSeek V4 Flash' }]);
    const cat = store.get(CATALOG_KEY);
    expect(cat).toMatchObject({
      source: 'chat.deepseek.com',
      capturedAt: expect.any(Number),
      models: [{ label: 'DeepSeek V4 Flash' }],
    });
  });
});

describe('getModelsCatalog', () => {
  it('returns null when storage is empty', async () => {
    expect(await getModelsCatalog()).toBeNull();
  });
  it('returns null when catalog older than 7 days', async () => {
    store.set(CATALOG_KEY, { source: 'chat.deepseek.com', capturedAt: Date.now() - 8 * 24 * 3600 * 1000, models: [] });
    expect(await getModelsCatalog()).toBeNull();
  });
  it('returns catalog when within 7-day TTL', async () => {
    const oneDayAgo = Date.now() - 1 * 24 * 3600 * 1000;
    store.set(CATALOG_KEY, { source: 'chat.deepseek.com', capturedAt: oneDayAgo, models: [{ label: 'x' }] });
    const cat = await getModelsCatalog();
    expect(cat).toMatchObject({ source: 'chat.deepseek.com', capturedAt: oneDayAgo, models: [{ label: 'x' }] });
  });
});