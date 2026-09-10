import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountLog } from '../../../src/debug/tabs/log';

const logs = [
  { at: 1000, provider: 'p', model: 'm', ok: true,  ms: 10, action: 'incremental' as const, cid: 'c1' },
  { at: 2000, provider: 'p', model: 'm', ok: false, ms: 10, error: 'token expired',        cid: 'c2' },
  { at: 3000, provider: 'p', model: 'm', ok: true,  ms: 10, action: 'rebuild' as const,     cid: 'c3' },
];

// 拦截 listener（panel-api.test.ts / routing.test.ts 同模式）：postMessage 同步把响应喂回去，
// 让 listLogs() 不挂起。brief 自带的 addListener: (fn) => fn({...}) 会在 pending 还没登记前
// 就触发 listener，丢消息；这里改用 portListeners 捕获，等 listLogs() postMessage 后再喂。
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
  // panel-api singleton 在第一次 connect 时建好，后续测试复用同一个 port。
});

describe('mountLog', () => {
  it('渲染过滤栏 + 列表 + 刷新按钮', () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      expect(pane.querySelector('[data-filter-action]')).toBeTruthy();
      expect(pane.querySelector('[data-search]')).toBeTruthy();
      expect(pane.querySelector('[data-refresh]')).toBeTruthy();
      expect(pane.querySelector('[data-list]')).toBeTruthy();
    } finally { unmount(); }
  });

  it('初始拉取后渲染 3 行', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      // mount 时已经触发一次 refresh → 喂第一个响应
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      expect(pane.querySelectorAll('[data-row]').length).toBe(3);
    } finally { unmount(); }
  });

  it('action=rebuild 过滤后剩 1 行', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      const cb = pane.querySelector<HTMLInputElement>('[data-filter-action-rebuild]')!;
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      expect(pane.querySelectorAll('[data-row]').length).toBe(1);
    } finally { unmount(); }
  });

  it('搜索 token 命中 1 行', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      const search = pane.querySelector<HTMLInputElement>('[data-search]')!;
      search.value = 'token';
      search.dispatchEvent(new Event('input'));
      expect(pane.querySelectorAll('[data-row]').length).toBe(1);
    } finally { unmount(); }
  });

  it('ok 过滤只勾 ok 剩 2 行', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      const cb = pane.querySelector<HTMLInputElement>('[data-filter-ok]')!;
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      // logs[0] ok=true, logs[1] ok=false, logs[2] ok=true → 2 rows
      expect(pane.querySelectorAll('[data-row]').length).toBe(2);
    } finally { unmount(); }
  });

  it('action=undefined checkbox filters undefined-action rows', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      const undefCb = pane.querySelector<HTMLInputElement>('[data-filter-action-undefined]')!;
      // 只勾 undefined → logs[1]（action 字段省略→undefined）命中，其余被排除
      undefCb.checked = true;
      undefCb.dispatchEvent(new Event('change'));
      expect(pane.querySelectorAll('[data-row]').length).toBe(1);
      const undefRowText = pane.querySelector('[data-row]')!.textContent ?? '';
      expect(undefRowText).toContain('token expired');  // logs[1] 的 error 字段
      // 不勾 undefined、勾 rebuild → logs[1] 被排除，logs[2] 命中
      undefCb.checked = false;
      undefCb.dispatchEvent(new Event('change'));
      const rebuildCb = pane.querySelector<HTMLInputElement>('[data-filter-action-rebuild]')!;
      rebuildCb.checked = true;
      rebuildCb.dispatchEvent(new Event('change'));
      const rows = pane.querySelectorAll('[data-row]');
      expect(rows.length).toBe(1);
      expect(rows[0]!.textContent).not.toContain('token expired');
    } finally { unmount(); }
  });

  it('每行渲染 at / provider / model / ok / ms / action / cid + reply/💭reason 双行内容块', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      portListeners.msg!({ kind: 'state', payload: { log: logs } });
      await new Promise(r => setTimeout(r, 10));
      const row = pane.querySelector('[data-row]')!;
      // 2026-09-09（diag/reasoning-sample）：原 8 列单行变 3 行块——顶行元数据 + reply:行 + 💭reason:行
      // Pro 场景一眼看见「reason 有内容、reply 为空」
      const text = row.textContent ?? '';
      expect(text).toContain('reply:');
      expect(text).toContain('💭reason:');
      expect(text).toContain('ok');     // ok|err
      expect(text).toContain('10ms');   // ms
      // 元数据项都在
      expect(text).toMatch(/p/);        // provider 含 p
      expect(text).toMatch(/m/);        // model 含 m
    } finally { unmount(); }
  });
});

// 2026-09-11（fix/review-r1）：失败原因被 replySample 吃掉 + 字段未转义（HTML 注入）。
describe('mountLog review-r1', () => {
  const feed = async (pane: HTMLElement, log: unknown[]): Promise<void> => {
    portListeners.msg!({ kind: 'state', payload: { log } });
    await new Promise(r => setTimeout(r, 10));
  };

  it('ok:false 且同时有 replySample 时，error 仍渲染出来', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      await feed(pane, [{ at: 1, provider: 'p', model: 'm', ok: false, ms: 5, error: 'tool call parse failed', replySample: '<tool_calls>[1,2]' }]);
      expect(pane.textContent).toContain('tool call parse failed');
      // reply 只放 replySample（不再回退成 error 的重复展示）
      expect(pane.textContent).toContain('<tool_calls>[1,2]');
    } finally { unmount(); }
  });

  it('replySample 里的 HTML 被转义（模型输出不可注入 DOM）', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      await feed(pane, [{ at: 1, provider: 'p', model: 'm', ok: true, ms: 5, replySample: '<img src=x onerror=alert(1)>' }]);
      expect(pane.querySelector('img')).toBeNull();
      expect(pane.textContent).toContain('<img src=x onerror=alert(1)>');
    } finally { unmount(); }
  });

  it('cid / provider / model 里的 HTML 被转义（调用方可控字段）', async () => {
    const pane = document.createElement('div');
    const unmount = mountLog(pane);
    try {
      await feed(pane, [{ at: 1, provider: '<img src=x>', model: '<img src=y>', ok: true, ms: 5, cid: '<img src=z>' }]);
      expect(pane.querySelector('img')).toBeNull();
    } finally { unmount(); }
  });
});
