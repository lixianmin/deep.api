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

import { mergeWithHardcoded, type MergedModel } from '../../src/background/providers/deepseek/client';

const HARDCODED: MergedModel[] = [
  { id: 'deepseek-v4-flash', modelType: 'default', thinking: true, limitChars: 2621440, description: '' },
  { id: 'deepseek-v4-pro', modelType: 'expert', thinking: true, limitChars: 163840, description: '' },
  { id: 'deepseek-v4-flash-vision-exp', modelType: 'vision', thinking: true, limitChars: 2621440, description: '' },
];

describe('mergeWithHardcoded', () => {
  it('returns hardcoded copy when catalog is null', () => {
    expect(mergeWithHardcoded(null, HARDCODED)).toEqual(HARDCODED);
  });
  it('enriches description + capturedAt from catalog by id match', () => {
    const cat = { capturedAt: 123, models: [
      { label: 'DeepSeek V4 Flash' },
      { label: 'New Unknown Model' },
    ] };
    const merged = mergeWithHardcoded(cat, HARDCODED);
    expect(merged[0]).toMatchObject({
      id: 'deepseek-v4-flash', description: 'DeepSeek V4 Flash',
      capturedAt: 123, source: 'chat.deepseek.com',
    });
    expect(merged[1]?.description).toBe('deepseek-v4-pro');  // unknown label → no enrich
    expect(merged[2]?.description).toBe('deepseek-v4-flash-vision-exp');
  });
  it('does not mutate the input hardcoded array', () => {
    const original = HARDCODED.slice();  // shallow copy
    const cat = { capturedAt: 999, models: [{ label: 'DeepSeek V4 Pro' }] };
    mergeWithHardcoded(cat, HARDCODED);
    expect(HARDCODED).toEqual(original);
  });
});