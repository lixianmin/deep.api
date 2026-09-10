// @vitest-environment jsdom
// 2026-09-11（fix/review-r1）：content bridge 层全量审查修复的回归用例。
// A1 非流式错误被空 onError 吞掉（Promise 永不 settle）
// A2 请求丢失（relay 断线静默丢弃）后调用方永久挂起 —— 需要看门狗兜底
// A4 Storage.prototype 补丁未保护/顺序错误会拖垮 window.deepApi 暴露
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// bridge-main 有 import 副作用（挂 window.deepApi + message listener），先加载再断言
import '../../src/content/bridge-main';

const WATCHDOG_MS = 10 * 60 * 1000;   // spec §4.5：10 分钟无进度断流

type DeepApi = {
  chat: { completions: { create: (p: unknown) => unknown } };
  models: { list: () => Promise<unknown> };
};
const api = (): DeepApi => (window as unknown as { deepApi: DeepApi }).deepApi;

let capturedRequestId: number | null = null;
let origPostMessage: typeof window.postMessage;

beforeEach(() => {
  capturedRequestId = null;
  origPostMessage = window.postMessage.bind(window);
  window.postMessage = ((msg: unknown) => {
    const env = (msg as { __deepApi?: { method?: string; id?: number } } | undefined)?.__deepApi;
    if (env && typeof env.id === 'number') capturedRequestId = env.id;
  }) as typeof window.postMessage;
});

afterEach(() => {
  window.postMessage = origPostMessage;
});

function fireResponseEvent(data: unknown): void {
  const ev = new MessageEvent('message', { data, source: window });
  window.dispatchEvent(ev);
}

function readAllFrames(res: Response): Promise<string> {
  return (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder('utf-8');
    let acc = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
    }
    return acc;
  })();
}

const REQ = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] };

describe('A1 非流式错误帧必须 reject（不再被空 onError 吞掉）', () => {
  it('非流式 create 收到 error 帧 → reject BridgeError（code/status 正确）', async () => {
    const p = api().chat.completions.create(REQ) as Promise<unknown>;
    expect(capturedRequestId).not.toBeNull();
    fireResponseEvent({
      __deepApi: {
        id: capturedRequestId,
        kind: 'error',
        error: { error: { message: '未登录 chat.deepseek.com', type: 'api_error', code: 'provider_unavailable' } },
      },
    });
    await expect(p).rejects.toMatchObject({
      status: 503,
      error: { error: { code: 'provider_unavailable', message: '未登录 chat.deepseek.com' } },
    });
  });

  it('models.list 收到 error 帧 → reject BridgeError', async () => {
    const p = api().models.list();
    fireResponseEvent({
      __deepApi: { id: capturedRequestId, kind: 'error', error: { error: { message: 'unknown model', type: 'api_error', code: 'invalid_request_error' } } },
    });
    await expect(p).rejects.toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
  });

  it('非流式成功路径仍 resolve（回归保护）', async () => {
    const p = api().chat.completions.create(REQ) as Promise<unknown>;
    fireResponseEvent({ __deepApi: { id: capturedRequestId, kind: 'result', value: { ok: true } } });
    await expect(p).resolves.toMatchObject({ ok: true });
  });
});

describe('A2 请求看门狗（消息丢失不再永久挂起）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('导出的看门狗常量 = 10 分钟（spec §4.5）', async () => {
    const mod = await import('../../src/content/bridge-main');
    expect((mod as { REQUEST_WATCHDOG_MS?: number }).REQUEST_WATCHDOG_MS).toBe(WATCHDOG_MS);
  });

  it('非流式：10 分钟无响应 → reject provider_unavailable 503', async () => {
    const p = api().chat.completions.create(REQ) as Promise<unknown>;
    const assertion = expect(p).rejects.toMatchObject({
      status: 503,
      error: { error: { code: 'provider_unavailable' } },
    });
    vi.advanceTimersByTime(WATCHDOG_MS + 1);
    await assertion;
  });

  it('流式：10 分钟无响应 → error 帧 + [DONE]（consumer 不 hang）', async () => {
    const res = api().chat.completions.create({ ...REQ, stream: true }) as Response;
    vi.advanceTimersByTime(WATCHDOG_MS + 1);
    const body = await readAllFrames(res);
    expect(body).toContain('"code":"provider_unavailable"');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('流式：收到 chunk 会重置看门狗（活跃长流不被误杀）', async () => {
    const res = api().chat.completions.create({ ...REQ, stream: true }) as Response;
    const id = capturedRequestId!;
    const reading = readAllFrames(res);
    vi.advanceTimersByTime(WATCHDOG_MS - 1000);
    fireResponseEvent({ __deepApi: { id, kind: 'chunk', chunk: { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] } } });
    vi.advanceTimersByTime(WATCHDOG_MS - 1000);   // 未重置的话此刻已超时
    fireResponseEvent({ __deepApi: { id, kind: 'done' } });
    const body = await reading;
    expect(body).not.toContain('"code":"provider_unavailable"');
    expect(body).toContain('"content":"hi"');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('A4 Storage.prototype 补丁不得拖垮 deepApi 暴露', () => {
  afterEach(() => {
    // 复原 jsdom 全局，避免影响后续用例
    vi.resetModules();
    Object.defineProperty(window, 'location', { value: { hostname: 'localhost' }, configurable: true, writable: true });
  });

  it('Storage.prototype.setItem/removeItem 不可写时，window.deepApi 仍被暴露且不抛', async () => {
    const descSet = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!;
    const descRemove = Object.getOwnPropertyDescriptor(Storage.prototype, 'removeItem')!;
    // 模拟被页面/其他扩展冻结的原型：严格模式下（ESM）裸赋值会抛 TypeError
    Object.defineProperty(Storage.prototype, 'setItem', { ...descSet, writable: false });
    Object.defineProperty(Storage.prototype, 'removeItem', { ...descRemove, writable: false });
    // 让 shouldSyncAuth() 为真——补丁只在 deepseek 域安装
    Object.defineProperty(window, 'location', { value: { hostname: 'chat.deepseek.com' }, configurable: true, writable: true });
    vi.resetModules();
    try {
      await expect(import('../../src/content/bridge-main')).resolves.toBeTruthy();
      expect((window as unknown as { deepApi?: unknown }).deepApi).toBeTruthy();
    } finally {
      Object.defineProperty(Storage.prototype, 'setItem', descSet);
      Object.defineProperty(Storage.prototype, 'removeItem', descRemove);
    }
  });
});
