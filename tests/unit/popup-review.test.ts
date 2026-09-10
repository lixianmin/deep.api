// @vitest-environment jsdom
// 2026-09-11（fix/review-r1）：popup 全量审查修复的回归用例。
// 为什么单独开文件：popup.ts 是带顶层副作用的模块（chrome.runtime.connect + getElementById 接线），
// 需要在 jsdom 里注入 popup.html 的 DOM + chrome/fetch stub 才能真正跑 render()。
// 纯渲染函数（转义）走 snippet.ts，直接断言输出字符串。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { escapeHtml, renderLogListHtml, renderModelListHtml } from '../../src/popup/snippet';

const here = dirname(fileURLToPath(import.meta.url));
const popupHtml = readFileSync(join(here, '../../src/popup/popup.html'), 'utf8');
const bodyHtml = popupHtml.slice(popupHtml.indexOf('<body>') + '<body>'.length, popupHtml.indexOf('</body>'));

type StateMsg = (m: unknown) => void;
let listener: StateMsg | undefined;
let disconnectListener: (() => void) | undefined;
let connectCalls = 0;
const posted: Array<{ kind: string; payload?: unknown }> = [];
let postMessageImpl: (m: { kind: string; payload?: unknown }) => void = (m) => { posted.push(m); };
const port = {
  onMessage: { addListener: (fn: StateMsg) => { listener = fn; } },
  onDisconnect: { addListener: (fn: () => void) => { disconnectListener = fn; } },
  postMessage: (m: { kind: string; payload?: unknown }) => { postMessageImpl(m); },
};

const logEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: 1_700_000_000_000, provider: 'deepseek', model: 'deepseek-flash', ok: true, ms: 12, ...over,
});

async function boot(): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  listener = undefined;
  disconnectListener = undefined;
  connectCalls = 0;
  posted.length = 0;
  postMessageImpl = (m) => { posted.push(m); };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { connect: () => { connectCalls++; return port; }, getURL: (p: string) => 'chrome-extension://test/' + p },
    tabs: { create: vi.fn() },
  };
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ json: async () => ({ version: '0.0.0-test' }) }));
  // 2s 心跳用真 setInterval 会跨用例泄漏（旧模块实例的定时器继续跑，干扰 connect 计数）。
  // 只在 import 期间把 setInterval 换成不启动的桩——模块顶层注册的心跳定时器不再真实运行。
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 1 as unknown as ReturnType<typeof setInterval>) as never);
  try { await import('../../src/popup/popup'); } finally { spy.mockRestore(); }
}

const emit = (payload: Record<string, unknown>): void => { listener!({ kind: 'state', payload }); };
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

beforeEach(() => { /* 每个用例自行 boot（要重置 DOM 与模块单例） */ });

describe('popup review-r1: 渲染转义（B1）', () => {
  it('escapeHtml 覆盖 & < > " \'', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });

  it('renderLogListHtml：cid / error / model 里的 HTML 不产生标签', () => {
    const html = renderLogListHtml([logEntry({ cid: '<img src=c>', error: '<img src=e>', model: '<img src=m>' }) as never]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renderModelListHtml：description 里的 HTML 被转义', () => {
    const html = renderModelListHtml([{ id: 'm1', description: '<img src=d>' }]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('渲染到 DOM 后：日志里的 <img> 不成为元素，原文以纯文本呈现', async () => {
    await boot();
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [logEntry({ cid: '<img src=x onerror=alert(1)>' })] });
    const list = el('log-list');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('渲染到 DOM 后：模型 description 里的 <img> 不成为元素', async () => {
    await boot();
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [{ id: 'm1', description: '<img src=y>' }] } }, log: [] });
    expect(el('model-list').querySelector('img')).toBeNull();
  });
});

describe('popup review-r1: 心跳重渲染（B2）', () => {
  it('用户正在编辑输入框时不被 2s 心跳覆盖', async () => {
    await boot();
    const pool = el<HTMLInputElement>('pool-size');
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [] });
    expect(pool.value).toBe('2');

    pool.focus();
    emit({ providers: { deepseek: { poolSize: 5, ttlMinutes: 30, models: [] } }, log: [] });
    expect(pool.value).toBe('2');   // 正在编辑：不覆盖

    pool.blur();
    emit({ providers: { deepseek: { poolSize: 5, ttlMinutes: 30, models: [] } }, log: [] });
    expect(pool.value).toBe('5');   // 失焦后正常同步
  });

  it('state 未变化时不重建日志列表（保滚动位置 / 元素不被替换）', async () => {
    await boot();
    const log = [logEntry({ cid: 'c1' })];
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log });
    const first = el('log-list').firstElementChild;
    expect(first).toBeTruthy();
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [logEntry({ cid: 'c1' })] });
    expect(el('log-list').firstElementChild).toBe(first);   // 同一元素 = 未重建
  });
});

describe('popup review-r1: 配置输入校验（B3）', () => {
  it('清空线程池输入不发送 panel.setPool（避免 Number("")=0）', async () => {
    await boot();
    const pool = el<HTMLInputElement>('pool-size');
    pool.value = '';
    pool.dispatchEvent(new Event('change', { bubbles: true }));
    expect(posted.filter(m => m.kind === 'panel.setPool')).toEqual([]);
    expect(pool.value).toBe('2');   // 回填为当前 state 值
  });

  it('线程池 > 5 夹取到 5', async () => {
    await boot();
    const pool = el<HTMLInputElement>('pool-size');
    pool.value = '9';
    pool.dispatchEvent(new Event('change', { bubbles: true }));
    expect(posted).toContainEqual({ kind: 'panel.setPool', payload: { poolSize: 5 } });
  });

  it('TTL 清空同样不发送', async () => {
    await boot();
    const ttl = el<HTMLInputElement>('ttl-min');
    ttl.value = '';
    ttl.dispatchEvent(new Event('change', { bubbles: true }));
    expect(posted.filter(m => m.kind === 'panel.setTtl')).toEqual([]);
  });
});

describe('popup review-r1: 初始登录态与按钮文案（B4/B5）', () => {
  it('首个 state 之前不显示假红色「未登录」', async () => {
    await boot();
    const auth = el('auth-state');
    expect(auth.textContent).toContain('检查中');
    expect(auth.className).not.toContain('bad');
  });

  it('复制取证按钮 title 标注「最近 5 条」', () => {
    const btn = /id="btn-copy-forensic"[^>]*title="([^"]+)"/.exec(popupHtml);
    expect(btn?.[1]).toContain('5 条');
  });

  it('1.5s 内连点两次复制取证，按钮文案最终恢复为「复制取证」', async () => {
    await boot();
    (globalThis as unknown as { navigator: { clipboard: unknown } }).navigator.clipboard = { writeText: async () => undefined };
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [logEntry()] });
    const btn = el<HTMLButtonElement>('btn-copy-forensic');
    btn.click();
    await new Promise(r => setTimeout(r, 30));
    btn.click();                       // 第一次的闪现文案还没恢复就再点
    await new Promise(r => setTimeout(r, 1600));
    expect(btn.textContent).toBe('复制取证');
  });
});

describe('popup review-r1: Tab 高度不棘轮（B6）', () => {
  it('内容变矮后 min-height 随之变小（不被上一轮 min-height 抬高）', async () => {
    await boot();
    const heights = new Map<Element, number>();
    for (const p of Array.from(document.querySelectorAll('.tab-panel'))) {
      // 模拟浏览器行为：元素实际 scrollHeight 不会被设小的 min-height 压回去（min-height 会撑高）
      Object.defineProperty(p, 'scrollHeight', {
        configurable: true,
        get: () => Math.max(heights.get(p) ?? 0, Number.parseInt((p as HTMLElement).style.minHeight || '0', 10) || 0),
      });
    }
    const panels = Array.from(document.querySelectorAll<HTMLElement>('.tab-panel'));
    const home = panels[0]!; const logs = panels[1]!; const settings = panels[2]!;
    heights.set(home, 100); heights.set(logs, 50); heights.set(settings, 10);
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [] });
    expect(home.style.minHeight).toBe('100px');

    heights.set(home, 40); heights.set(logs, 20); heights.set(settings, 10);
    emit({ providers: { deepseek: { poolSize: 2, ttlMinutes: 30, models: [] } }, log: [] });
    expect(home.style.minHeight).toBe('40px');
    expect(logs.style.minHeight).toBe('40px');
  });
});

// 2026-09-11（fix/review-r2）：port 断线恢复（旧实现只 connect 一次，SW 回收后 UI 僵死）。
describe('popup review-r2: port 断线重连', () => {
  it('onDisconnect 后下一次 send 自动重连（不抛未捕获异常）', async () => {
    await boot();
    expect(connectCalls).toBe(1);
    disconnectListener!();   // 模拟 SW 被回收 / 扩展 reload
    el<HTMLButtonElement>('btn-resync-auth').click();
    expect(connectCalls).toBe(2);
    expect(posted.map((p) => p.kind)).toContain('panel.resyncAuth');
  });

  it('postMessage 抛「disconnected port」时重连一次并重发', async () => {
    await boot();
    let fails = 1;
    postMessageImpl = (m) => {
      if (fails-- > 0) throw new Error('Attempting to use a disconnected port object');
      posted.push(m);
    };
    // 不触发 onDisconnect：模拟「port 实际已死但 disconnect 事件尚未派发」的窗口
    el<HTMLButtonElement>('btn-resync-auth').click();
    expect(connectCalls).toBe(2);
    expect(posted.map((p) => p.kind)).toContain('panel.resyncAuth');
  });
});
