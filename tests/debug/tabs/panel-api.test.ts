import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPanelApi, PANEL_REQUEST_TIMEOUT_MS } from '../../../src/debug/tabs/panel-api';

// 在 jsdom 环境下，chrome.runtime 默认不存在；需要 stub
const portListeners: { msg?: (m: any) => void } = {};
const port = {
  onMessage: { addListener: (fn: any) => { portListeners.msg = fn; } },
  postMessage: vi.fn(),
  onDisconnect: { addListener: vi.fn() },
};
(globalThis as any).chrome = {
  runtime: {
    connect: vi.fn(() => port),
  },
};

describe('getPanelApi', () => {
  beforeEach(() => { (chrome.runtime.connect as any).mockClear(); port.postMessage.mockClear(); });

  it('单例：多次调用复用同一 connect', () => {
    const a = getPanelApi();
    const b = getPanelApi();
    expect(a).toBe(b);
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('listLogs 转发并解析', async () => {
    const api = getPanelApi();
    const p = api.listLogs();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'panel.listLogs' });
    portListeners.msg!({ kind: 'state', payload: { log: [{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }] } });
    await expect(p).resolves.toEqual([{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }]);
  });

  it('listThreads 转发并解析', async () => {
    const api = getPanelApi();
    const p = api.listThreads();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'panel.listThreads' });
    portListeners.msg!({ kind: 'state', payload: { threads: [{ conversationId: 'c1', kind: 'auto', mirrorLen: 1, webSessionId: 'w', parentMessageId: null, lastUsedAt: 1, busy: false }] } });
    await expect(p).resolves.toHaveLength(1);
  });
});

// 2026-09-11（fix/review-r1）：全量审查发现的两个缺陷回归用例。
describe('getPanelApi review-r1', () => {
  it('两个 tab 并发请求（乱序回包）各自 resolve 到正确 payload', async () => {
    const api = getPanelApi();
    const pl = api.listLogs();
    const pt = api.listThreads();
    const threads = [{ conversationId: 'c1', kind: 'auto', mirrorLen: 1, webSessionId: 'w', parentMessageId: null, lastUsedAt: 1, busy: false }];
    const logs = [{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }];
    // 乱序：先回 threads，再回 log
    portListeners.msg!({ kind: 'state', payload: { threads } });
    portListeners.msg!({ kind: 'state', payload: { log: logs } });
    await expect(pt).resolves.toEqual(threads);
    await expect(pl).resolves.toEqual(logs);
  });

  it('SW 主动广播（payload 含 providers）不结算在飞请求', async () => {
    const api = getPanelApi();
    const pt = api.listThreads();
    portListeners.msg!({ kind: 'state', payload: { providers: { deepseek: {} }, log: [{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }] } });
    let settled = false;
    void pt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);
    const threads = [{ conversationId: 'c9', kind: 'auto', mirrorLen: 1, webSessionId: 'w9', parentMessageId: null, lastUsedAt: 1, busy: false }];
    portListeners.msg!({ kind: 'state', payload: { threads } });
    await expect(pt).resolves.toEqual(threads);
  });

  it('请求超时 → reject（不永久挂起）', async () => {
    const api = getPanelApi();
    vi.useFakeTimers();
    try {
      const p = api.listThreads();
      const expectation = expect(p).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(PANEL_REQUEST_TIMEOUT_MS + 100);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('port 断开 → 在飞请求 reject，且下次调用重新 connect', async () => {
    const api = getPanelApi();
    const p = api.listLogs();
    const disconnectCb = (port.onDisconnect.addListener as any).mock.calls.at(-1)?.[0] as (() => void) | undefined;
    expect(typeof disconnectCb).toBe('function');
    const before = (chrome.runtime.connect as any).mock.calls.length;
    disconnectCb!();
    await expect(p).rejects.toThrow(/disconnect/i);
    getPanelApi();
    expect((chrome.runtime.connect as any).mock.calls.length).toBe(before + 1);
  });
});
