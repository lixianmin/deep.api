import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountSse } from '../../../src/demo/tabs/sse';

const logs = [
  { at: 1000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws1', replySample: 'hi' },
  { at: 2000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws1', replySample: 'world' },
  { at: 3000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws2', replySample: 'foo' },
];

// 拦截 listener（panel-api.test.ts / log.test.ts / routing.test.ts 同模式）：
// brief 自带的 addListener: (fn) => fn({...}) 会在 pending 还没登记前就触发 listener，
// 丢消息；这里改用 portListeners 捕获，等 listLogs() postMessage 后再喂。
const portListeners: { msg?: (m: any) => void } = {};
const port = {
  onMessage: { addListener: (fn: any) => { portListeners.msg = fn; } },
  postMessage: vi.fn(),
  onDisconnect: { addListener: vi.fn() },
};
(globalThis as any).chrome = {
  runtime: { connect: vi.fn(() => port) },
};

beforeEach(() => {
  port.postMessage.mockClear();
  (chrome.runtime.connect as any).mockClear();
  // 不要清掉 portListeners.msg：panel-api 单例跨测试存活（singleton），清掉后 listLogs 永远挂起。
});

describe('mountSse', () => {
  it('按 webSessionId 分组渲染', async () => {
    const pane = document.createElement('div');
    const unmount = mountSse(pane);
    try {
      // mount 时已经触发一次 refresh → 喂第一个响应
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      expect(pane.querySelectorAll('[data-group]').length).toBe(2);  // ws1, ws2
    } finally { unmount(); }
  });

  it('每组展示 replySample 摘要', async () => {
    const pane = document.createElement('div');
    const unmount = mountSse(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      expect(pane.textContent).toContain('hi');
      expect(pane.textContent).toContain('foo');
    } finally { unmount(); }
  });
});