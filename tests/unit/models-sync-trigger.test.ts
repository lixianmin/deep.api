// 2026-09-14（fix/models-v4-retired）：content script trigger 测试。
// 必须在 import 之前设 __MODELS_SYNC_TEST=true 跳过发布副作用（默认 15×1s poll 阻塞测试）。
(globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST = true;
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWith } from '../../src/content/models-sync';

// 跨测试隔离：每次 beforeEach 重置 document / location / chrome
const resetTestEnv = (): void => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'location', { value: { hostname: 'chat.deepseek.com' }, configurable: true, writable: true });
  (globalThis as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn() },
  };
};

describe('content script trigger on chat.deepseek.com (2026-09-14 fix/models-v4-retired)', () => {
  beforeEach(resetTestEnv);

  it('extracts + sends when the model trigger is present', async () => {
    document.body.innerHTML = `
      <button data-testid="model-trigger">current</button>
      <div role="listbox">
        <div role="option">default</div>
        <div role="option">DeepSeek V4.1 Flash</div>
      </div>
    `;
    startWith({ pollIntervalMs: 5, pollMaxTries: 10, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 200));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    const calls = send.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1]![0] as { method: string; models: { label: string }[] };
    expect(lastCall).toMatchObject({ method: 'models-catalog:update' });
    const labels = lastCall.models.map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(['default', 'DeepSeek V4.1 Flash']));
  });

  it('does not throw and does not send when no trigger present', async () => {
    document.body.innerHTML = '<div>nothing</div>';
    startWith({ pollIntervalMs: 5, pollMaxTries: 3, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 100));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    expect(send.mock.calls.length).toBe(0);
  });

  it('does nothing on non-deepseek hostnames', async () => {
    (window as { location: { hostname: string } }).location.hostname = 'example.com';
    document.body.innerHTML = `
      <button data-testid="model-trigger">x</button>
      <div role="listbox"><div role="option">default</div></div>
    `;
    startWith({ pollIntervalMs: 5, pollMaxTries: 3, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    expect(send).not.toHaveBeenCalled();
  });
});

// 2026-09-11（fix/review-r1 A5）：合成点击自触发风暴。
// 旧实现：document 捕获阶段监听一切 click → pollOnce；而 captureOnceSettle 自己合成
// trigger.click() 与 document.body.click()，两次都被自己的 listener 接住 → 每代派生 2 条 poll 链
// （指数级点击/消息风暴），且 pollOnce 无 in-flight 门闩可无限并发。
//
// 注意：jsdom 的事件 isTrusted 不可伪造（own property，non-configurable），所以「真实用户点击」
// 通过调用被捕获的 listener 处理器 + 模拟 trusted 事件来驱动（评审建议的独立单测路径）。
describe('content script trigger 防自触发风暴（review-r1 A5）', () => {
  const MODEL_DOM = `
    <button data-testid="model-trigger">current</button>
    <div role="listbox">
      <div role="option">default</div>
    </div>
  `;

  const setReadyState = (v: string): void => {
    Object.defineProperty(document, 'readyState', { value: v, configurable: true });
  };

  /** 捕获 startWith 注册的 document click 处理器（capture 阶段），用于模拟真实用户点击。 */
  const captureClickHandlers = (): Array<(ev: unknown) => void> => {
    const handlers: Array<(ev: unknown) => void> = [];
    const original = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'click') handlers.push(fn as (ev: unknown) => void);
      return original(type as keyof DocumentEventMap, fn as EventListenerOrEventListenerObject, opts as AddEventListenerOptions);
    }) as typeof document.addEventListener);
    return handlers;
  };

  const fireUserClick = (handlers: Array<(ev: unknown) => void>): void => {
    for (const h of handlers) h({ isTrusted: true });
  };

  const fastOpts = { pollIntervalMs: 100, pollMaxTries: 50, clickSettleMs: 5, retryDelayMs: 1000 };

  beforeEach(() => {
    // 打开真实 listener 注册路径（旧的 __MODELS_SYNC_TEST 会整段跳过——测试盲区正是风暴所在）
    (globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST = false;
    // isTargetHost() 必须先命中，否则 startWith 直接 return（本 describe 不共享外层 resetTestEnv）
    Object.defineProperty(window, 'location', { value: { hostname: 'chat.deepseek.com' }, configurable: true, writable: true });
    setReadyState('loading');   // 不触发 startWith 的初始 poll，由测试自己驱动
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setReadyState('complete');
    (globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST = true;
  });

  it('脚本自己合成的 click（isTrusted=false）不再派发 poll', async () => {
    document.body.innerHTML = MODEL_DOM;
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const handlers = captureClickHandlers();
    startWith({ ...fastOpts, clickListener: true });
    for (const h of handlers) h({ isTrusted: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('同刻多次真实点击只跑一条 capture 链（不按点击次数放大）', async () => {
    document.body.innerHTML = MODEL_DOM;
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const handlers = captureClickHandlers();
    startWith({ ...fastOpts, clickListener: true });
    fireUserClick(handlers);
    fireUserClick(handlers);
    fireUserClick(handlers);
    await vi.advanceTimersByTimeAsync(500);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('in-flight 门闩：上一次 capture 未结束时的再次点击不派发第二条 poll', async () => {
    document.body.innerHTML = '<button data-testid="model-trigger">current</button>';   // 无 listbox → capture 一直失败重试
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const handlers = captureClickHandlers();
    // pollIntervalMs 故意拉长：窗口内只有「被阻止的 poll B」可能新增 click，测量无歧义
    startWith({ pollIntervalMs: 2000, pollMaxTries: 50, clickSettleMs: 5, retryDelayMs: 100000, clickListener: true });
    fireUserClick(handlers);                  // t=0 → poll A 在 t=5 点一次，然后等 2000ms
    await vi.advanceTimersByTimeAsync(1100);
    const callsBefore = clickSpy.mock.calls.length;
    expect(callsBefore).toBe(1);
    fireUserClick(handlers);                  // 距上次 > 1s 节流窗口，允许入队 → poll B 本应在 t+5 触发
    await vi.advanceTimersByTimeAsync(20);
    expect(clickSpy.mock.calls.length).toBe(callsBefore);   // 门闩挡住：poll A 未结束，poll B 不跑
  });

  it('关闭下拉用 Escape 键，不再合成 document.body.click()', async () => {
    document.body.innerHTML = MODEL_DOM;
    // 先静默原型 click（否则 body.click() 会派发真实事件 → 观察者效应制造风暴）；再 spy body 实例
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const bodyClick = vi.spyOn(document.body, 'click');
    const keydowns: string[] = [];
    document.addEventListener('keydown', (e) => keydowns.push((e as KeyboardEvent).key));
    const handlers = captureClickHandlers();
    startWith({ ...fastOpts, clickListener: true });
    fireUserClick(handlers);
    await vi.advanceTimersByTimeAsync(500);
    expect(bodyClick).not.toHaveBeenCalled();
    expect(keydowns).toContain('Escape');
  });
});
