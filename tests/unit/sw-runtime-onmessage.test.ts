import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CATALOG_KEY } from '../../src/background/models-sync';
import { registerCatalogListener } from '../../src/background/register-catalog-listener';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => unknown;
const store = new Map<string, unknown>();
let listener: Listener | undefined;
function setChromeRef() {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        set: (kv: Record<string, unknown>) => { for (const [k, v] of Object.entries(kv)) store.set(k, v); },
        get: (k: string, cb: (kv: Record<string, unknown>) => void) => { cb({ [k]: store.get(k) }); },
      },
    },
    runtime: {
      onMessage: {
        addListener: (l: Listener) => { listener = l; },
      },
    },
  });
}
beforeEach(() => { store.clear(); listener = undefined; setChromeRef(); });

describe('registerCatalogListener (chrome.runtime.onMessage)', () => {
  // 2026-09-10（feat/models-sync fix-r1）：spec §3.6 cross-domain message protocol.
  // Content script 用 chrome.runtime.sendMessage —— SW 必须用 chrome.runtime.onMessage 接.
  // bridge 的 port.onMessage 不覆盖这条通道. 修复 R1.

  it('registers a chrome.runtime.onMessage listener', () => {
    registerCatalogListener();
    expect(listener).toBeDefined();
  });

  it('writes catalog when message is models-catalog:update with array', () => {
    registerCatalogListener();
    let responded: unknown = undefined;
    listener!({ method: 'models-catalog:update', models: [{ label: 'DeepSeek V4 Flash' }] }, {}, (r) => { responded = r; });
    const cat = store.get(CATALOG_KEY);
    expect(cat).toMatchObject({ source: 'chat.deepseek.com', models: [{ label: 'DeepSeek V4 Flash' }] });
    expect(responded).toEqual({ ok: true });
  });

  it('returns ok:false when models is not an array', () => {
    registerCatalogListener();
    let responded: unknown = undefined;
    listener!({ method: 'models-catalog:update', models: 'not-array' }, {}, (r) => { responded = r; });
    expect(store.has(CATALOG_KEY)).toBe(false);
    expect(responded).toEqual({ ok: false, error: 'models must be array' });
  });

  it('ignores unrelated methods (no storage write, no sendResponse)', () => {
    registerCatalogListener();
    let responded = false;
    listener!({ method: 'some-other-message' }, {}, () => { responded = true; });
    expect(store.has(CATALOG_KEY)).toBe(false);
    expect(responded).toBe(false);
  });

  it('silent fallback: storage errors do not propagate (onCatalogUpdate swallows per spec §3.5)', () => {
    // onCatalogUpdate 内部已经 try/catch storage.set 错误（spec §3.5 失败回退）——
    // 这里验证 listener 不传异常到调用方（即使 storage.set 拋）。
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          set: () => { throw new Error('storage dead'); },
          get: (_k: string, cb: (kv: Record<string, unknown>) => void) => cb({}),
        },
      },
      runtime: { onMessage: { addListener: (l: Listener) => { listener = l; } } },
    });
    registerCatalogListener();
    let responded: unknown = 'unset';
    expect(() => listener!({ method: 'models-catalog:update', models: [{ label: 'x' }] }, {}, (r) => { responded = r; })).not.toThrow();
    // onCatalogUpdate 吞了 error 后照常 sendResponse({ok: true})
    expect(responded).toEqual({ ok: true });
  });
});
