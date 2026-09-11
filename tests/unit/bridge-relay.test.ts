// @vitest-environment jsdom
// 2026-09-11（fix/review-r1 A3）：relay 断线重连必须有退避重试且不泄漏 window listener / interval。
// 旧实现：open() 的 catch 返回 null、onDisconnect 只重连一次（失败即永久断桥）；
// 且每次重连都 createRelay 一遍，window message listener 与 20s ping 定时器线性堆积。
// 2026-09-15（fix/relay-orphan-stop）：契约细化——「Extension context invalidated」（扩展重载/更新后
// 旧页面驻留脚本的上下文已销毁）是终态，重试永远失败只会刷屏；其余失败照旧退避重试。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakePort {
  postMessage: (m: unknown) => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
}
interface PortState { sent: unknown[]; forward: ((m: unknown) => void) | null; disconnect: (() => void) | null }

function makePort(): { port: FakePort; state: PortState } {
  const state: PortState = { sent: [], forward: null, disconnect: null };
  const port: FakePort = {
    postMessage: (m: unknown) => { state.sent.push(m); },
    onMessage: { addListener: (cb) => { state.forward = cb; } },
    onDisconnect: { addListener: (cb) => { state.disconnect = cb; } },
  };
  return { port, state };
}

const bridgeRequest = (id: number) => ({ __deepApi: { id, method: 'models.list', params: {} } });

describe('bridge-relay 重连与副作用清理（review-r1 A3）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connect 失败按退避重试直到成功；window listener / ping interval 各只装一次', async () => {
    const ports: Array<{ port: FakePort; state: PortState }> = [];
    let attempt = 0;
    const connect = vi.fn(() => {
      attempt++;
      // 2026-09-15（fix/relay-orphan-stop）：原用「Extension context invalidated」当通用失败错误，
      // 该错误现定义为终态；改用非终态的临时性失败文案（SW 未就绪等）。
      if (attempt <= 2) throw new Error('connect failed: SW not ready');
      const made = makePort();
      ports.push(made);
      return made.port;
    });
    vi.stubGlobal('chrome', { runtime: { connect, id: 'test-ext-id' } });
    const addListener = vi.spyOn(window, 'addEventListener');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await import('../../src/content/bridge-relay');
    expect(connect).toHaveBeenCalledTimes(1);          // 首次失败即返回（旧实现到此为止，永久断桥）

    await vi.advanceTimersByTimeAsync(1000);           // 退避 1：第 2 次尝试
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);           // 退避 2：第 3 次尝试成功
    expect(connect).toHaveBeenCalledTimes(3);
    expect(ports).toHaveLength(1);

    const messageListeners = (): number => addListener.mock.calls.filter((c) => c[0] === 'message').length;
    expect(messageListeners()).toBe(1);
    expect(setIntervalSpy.mock.calls.length).toBe(1);

    // 断线 → 重连成功后不得新增 listener / interval（旧实现每次重连都净增一个）
    ports[0]!.state.disconnect!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(ports).toHaveLength(2);
    expect(messageListeners()).toBe(1);
    expect(setIntervalSpy.mock.calls.length).toBe(1);
  });

  // 2026-09-15（fix/relay-orphan-stop）：扩展重载后旧页面孤儿脚本的终态处理。
  it('connect 抛 Extension context invalidated → 终态：不再重试，提示刷新页面', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connect = vi.fn(() => { throw new Error('Extension context invalidated.'); });
    vi.stubGlobal('chrome', { runtime: { connect, id: 'test-ext-id' } });
    await import('../../src/content/bridge-relay');
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);        // 若仍在退避重试，次数会涨
    expect(connect).toHaveBeenCalledTimes(1);          // 终态：一次失败后永久停机
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(true);
  });

  it('chrome.runtime.id 缺失（孤儿上下文的可靠信号）→ 同样终态停止', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connect = vi.fn(() => { throw new Error('some unrelated failure'); });
    vi.stubGlobal('chrome', { runtime: { connect } }); // 无 id = 上下文已销毁
    await import('../../src/content/bridge-relay');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalidated'))).toBe(true);
  });

  it('重连后页面请求转发到最新 port（旧 port 已死不再使用）', async () => {
    const ports: Array<{ port: FakePort; state: PortState }> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext-id',
        connect: () => {
          const made = makePort();
          ports.push(made);
          return made.port;
        },
      },
    });
    await import('../../src/content/bridge-relay');
    expect(ports).toHaveLength(1);

    window.dispatchEvent(new MessageEvent('message', { data: bridgeRequest(1), source: null }));
    expect(ports[0]!.state.sent).toHaveLength(1);

    ports[0]!.state.disconnect!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports).toHaveLength(2);

    window.dispatchEvent(new MessageEvent('message', { data: bridgeRequest(2), source: null }));
    expect(ports[1]!.state.sent).toHaveLength(1);
    expect(ports[0]!.state.sent).toHaveLength(1);       // 旧的死 port 不再收到消息
  });

  it('SW → page 的响应经最新 port 的 onMessage 转发到 window', async () => {
    const ports: Array<{ port: FakePort; state: PortState }> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext-id',
        connect: () => {
          const made = makePort();
          ports.push(made);
          return made.port;
        },
      },
    });
    await import('../../src/content/bridge-relay');
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    ports[0]!.state.forward?.({ __deepApi: { id: 1, kind: 'done' } });
    expect(postMessage).toHaveBeenCalledWith({ __deepApi: { id: 1, kind: 'done' } }, '*');
  });
});
