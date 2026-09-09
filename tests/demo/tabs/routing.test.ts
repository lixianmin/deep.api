import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountRouting } from '../../../src/demo/tabs/routing';

// mock data：只覆盖 ThreadRow 必要字段；lastDecision 省略让表格显示空 cell（覆盖 ?? '' 分支）
const threads = [{
  conversationId: 'c1', kind: 'auto', mirrorLen: 2, webSessionId: 'ws',
  parentMessageId: null, lastUsedAt: 100, busy: false,
}];

// 拦截 listener（panel-api.test.ts 同模式）：postMessage 同步把响应喂回去，
// 让 listThreads() 不挂起。当前 brief 自带的 addListener: vi.fn() 会丢 listener，
// 这里扩展 beforeEach 替换为可注入的 stub。
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
  // 不要重置 portListeners.msg —— panel-api 单例跨测试存活（模块级 singleton），
  // 后续测试复用同一个 port + listener；清掉它会让 listThreads() 永远挂起。
  // 只清 mock 调用计数即可。
  port.postMessage.mockClear();
  (chrome.runtime.connect as any).mockClear();
  // 固定时间：REL() 算 lastUsedAt=100 → 900ms → "0 秒前"（可断言确定字符串）
  vi.spyOn(Date, 'now').mockReturnValue(1000);
});

describe('mountRouting', () => {
  it('渲染表格表头 + 刷新按钮', () => {
    const pane = document.createElement('div');
    const unmount = mountRouting(pane);
    try {
      expect(pane.querySelector('table')).toBeTruthy();
      expect(pane.querySelector('[data-refresh]')).toBeTruthy();
    } finally { unmount(); }
  });

  it('点击刷新调 panel.listThreads 并填行', async () => {
    const pane = document.createElement('div');
    const unmount = mountRouting(pane);
    try {
      // mount 时已经触发一次 refresh → 喂第一个响应
      portListeners.msg!({ kind: 'state', payload: { threads } });
      // 点击刷新 → 再触发一次 → 喂第二个响应
      pane.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
      portListeners.msg!({ kind: 'state', payload: { threads } });
      // 等微任务队列走完
      await new Promise(r => setTimeout(r, 10));
      expect(port.postMessage).toHaveBeenCalledWith({ kind: 'panel.listThreads' });
      expect(pane.querySelectorAll('tbody tr')).toHaveLength(threads.length);
      // 数据回填：行单元格包含 conversationId
      expect(pane.querySelector('tbody tr')?.textContent).toContain('c1');
    } finally { unmount(); }
  });
});