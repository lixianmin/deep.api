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

// 2026-09-14（fix/models-v4-retired）：V4 三个 ID 全部 retired。hardcoded 只 1 个。
const HARDCODED: MergedModel[] = [
  { id: 'deepseek-flash', modelType: 'default', thinking: true, limitChars: 2621440, description: 'DeepSeek V4.1 Flash — 快速/便宜，统一默认模型' },
];

describe('mergeWithHardcoded', () => {
  it('returns hardcoded copy when catalog is null', () => {
    expect(mergeWithHardcoded(null, HARDCODED)).toEqual(HARDCODED);
  });
  it('enriches description + capturedAt from catalog by id match (V4.1 unified)', () => {
    const cat = { capturedAt: 123, models: [
      { label: 'default' },  // V4.1 UI 文案
      { label: 'DeepSeek V4.1 Flash' },  // V4.1 完整标签
    ] };
    const merged = mergeWithHardcoded(cat, HARDCODED);
    // 两条 label 都匹配 deepseek-flash，mergeWithHardcoded 用 Map.set() 覆盖——
    // 语义是 last-write-wins（与 router.models() 的 find()  first-match-wins 路径不同；
    //  router.ts 中实现用 find() 是为了反映 UI 选项顺序）。
    expect(merged[0]).toMatchObject({
      id: 'deepseek-flash', description: 'DeepSeek V4.1 Flash',
      capturedAt: 123, source: 'chat.deepseek.com',
    });
  });
  it('does not mutate the input hardcoded array', () => {
    const original = HARDCODED.slice();
    const cat = { capturedAt: 999, models: [{ label: 'DeepSeek V4.1 Flash' }] };
    mergeWithHardcoded(cat, HARDCODED);
    expect(HARDCODED).toEqual(original);
  });
});