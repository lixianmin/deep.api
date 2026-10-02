// @vitest-environment jsdom
// 2026-10-05（chore/chatgpt-relay-info）：chatgpt-bridge-relay 的终态停机提示此前无任何直接测试
// （只被 relay-recovery 的注入清单间接覆盖），于是它的日志级别没人守：bridge-relay 那条在
// f4ccab1 降为 info 后，chatgpt 这条仍是 warn，用户在 chatgpt.com 标签页继续被宿主页面的
// 错误收集器（Paseo IDE 的 Errors 面板）收走。本文件锁住级别契约。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakePort {
  postMessage: (m: unknown) => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
}

function makePort(): FakePort {
  return {
    postMessage: () => undefined,
    onMessage: { addListener: () => undefined },
    onDisconnect: { addListener: () => undefined },
  };
}

describe('chatgpt-bridge-relay 终态停机的日志级别', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    // jsdom window 跨测试持久，上一用例登记的 __deepApiChatGPTRelay 会触发
    // 同世代让位守卫（isAlive → chrome.runtime.id），必须逐用例清掉。
    delete (window as { __deepApiChatGPTRelay?: unknown }).__deepApiChatGPTRelay;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connect 抛 Extension context invalidated → 终态停机，只打 info 不打 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const connect = vi.fn(() => { throw new Error('Extension context invalidated.'); });
    vi.stubGlobal('chrome', { runtime: { connect, id: 'test-ext-id' } });

    await import('../../src/content/chatgpt-bridge-relay');
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);       // 若仍在退避重试，次数会涨
    expect(connect).toHaveBeenCalledTimes(1);         // 终态：一次失败后永久停机
    expect(info.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(false);
  });

  it('chrome.runtime.id 缺失（孤儿上下文的可靠信号）→ 同样只打 info', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const connect = vi.fn(() => { throw new Error('some unrelated failure'); });
    vi.stubGlobal('chrome', { runtime: { connect } }); // 无 id = 上下文已销毁

    await import('../../src/content/chatgpt-bridge-relay');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(false);
  });

  it('非终态的 connect 失败仍照旧退避重试（降级只针对终态那一条）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempt = 0;
    const connect = vi.fn(() => {
      attempt++;
      if (attempt <= 2) throw new Error('connect failed: SW not ready');
      return makePort();
    });
    vi.stubGlobal('chrome', { runtime: { connect, id: 'test-ext-id' } });

    await import('../../src/content/chatgpt-bridge-relay');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connect.mock.calls.length).toBeGreaterThan(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('connect failed, retrying'))).toBe(true);
  });
});
