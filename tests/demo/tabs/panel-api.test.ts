import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPanelApi } from '../../../src/demo/tabs/panel-api';

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
