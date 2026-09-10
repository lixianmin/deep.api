import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountSse } from '../../../src/debug/tabs/sse';

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
// 2026-09-11（fix/review-r1）：分组标题时间取自倒序数组首元素（最新），应取组内最早。
describe('mountSse review-r1', () => {
  it('分组标题按「最早 → 最新」标时间', async () => {
    const pane = document.createElement('div');
    const unmount = mountSse(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: [
        { at: 1_000, provider: 'p', model: 'm', ok: true, ms: 1, webSessionId: 'wsT', replySample: 'old' },
        { at: 62_000, provider: 'p', model: 'm', ok: true, ms: 1, webSessionId: 'wsT', replySample: 'new' },
      ] } });
      await new Promise(r => setTimeout(r, 10));
      const summary = pane.querySelector('summary')!.textContent ?? '';
      const oldest = new Date(1_000).toLocaleTimeString();
      const newest = new Date(62_000).toLocaleTimeString();
      expect(summary).toContain(oldest);
      expect(summary).toContain(newest);
      expect(summary.indexOf(oldest)).toBeLessThan(summary.indexOf(newest));
    } finally { unmount(); }
  });

  it('webSessionId / replySample 里的 HTML 被转义', async () => {
    const pane = document.createElement('div');
    const unmount = mountSse(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: [
        { at: 1, provider: 'p', model: 'm', ok: true, ms: 1, webSessionId: '<img src=w>', replySample: '<img src=r>' },
      ] } });
      await new Promise(r => setTimeout(r, 10));
      expect(pane.querySelector('img')).toBeNull();
    } finally { unmount(); }
  });
});
