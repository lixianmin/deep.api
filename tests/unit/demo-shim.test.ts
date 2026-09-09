import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('demo.js shim (chrome-extension:// demo 场景)', () => {
  beforeEach(() => {
    // 重置
    document.body.innerHTML = '';
    delete (window as any).deepApi;
    // mock chrome.runtime
    const listeners: any[] = [];
    (globalThis as any).chrome = {
      runtime: {
        connect: vi.fn(() => ({
          postMessage: vi.fn(),
          onMessage: {
            addListener: (fn: any) => listeners.push(fn),
          },
        })),
      },
    };
    // 加载 demo.js（会执行 shim 逻辑）
    vi.resetModules();
    return import(/* @ts-ignore */ '../../examples/demo-page/demo.js' as any).catch(() => undefined);
  });

  it('chrome-extension 场景：window.deepApi 注入并能调 models.list', async () => {
    // shim 应该注入 window.deepApi
    expect((window as any).deepApi).toBeTruthy();
    expect((window as any).deepApi.models.list).toBeTypeOf('function');
    expect((window as any).deepApi.chat.completions.create).toBeTypeOf('function');
  });
});
