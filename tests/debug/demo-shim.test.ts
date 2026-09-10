// Shim 端到端：用 Node vm 跑 extension/debug/demo.js bundle，模拟 chrome.runtime.connect
// 把 SW chunk 流回 shim，验证 tab 代码（res.body.getReader() + TextDecoder 切 SSE 帧）
// 能消费到内容。

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as vm from 'node:vm';

interface ShimMsg { __deepApi: { id: number; kind: string; chunk?: unknown; value?: unknown; error?: unknown; method?: string; params?: { stream?: boolean } } }

interface FakePort { onMessage: { addListener: (fn: (msg: ShimMsg) => void) => void }; onDisconnect: { addListener: () => void }; postMessage: (msg: unknown) => void; __listeners: Array<(msg: ShimMsg) => void> }
let port: FakePort;

const stubEl: any = new Proxy({
  appendChild: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  setAttribute: () => {}, querySelector: () => stubEl, querySelectorAll: () => [],
  classList: { add: () => {}, remove: () => {} },
  style: new Proxy({}, { set: () => true, get: () => '' }),
  dataset: new Proxy({}, { set: () => true, get: () => '' }),
}, { get: (t, p) => (p in t ? (t as any)[p] : () => {}) });

const stubDoc: any = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'body') return stubEl;
    if (prop === 'createElement' || prop === 'getElementById') return () => stubEl;
    if (prop === 'addEventListener' || prop === 'querySelectorAll' || prop === 'querySelector') return () => [];
    return () => {};
  },
});

// stubWin 每次 loadBundle 新建（避免上一个 test 装 window.deepApi 被下一个 test 的 !window.deepApi 检查跳过）
const makeWin = (): any => new Proxy({
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
  location: { hash: '' }, removeChild: () => {},
}, { get: (t, p) => (p in t ? (t as any)[p] : undefined) });

let ctx: vm.Context;
let stubWin: any;
let demoJs: string;

const loadBundle = (): void => {
  const newPort: FakePort = {
    onMessage: { addListener: (fn) => { newPort.__listeners.push(fn); } },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    __listeners: [],
  };
  port = newPort;
  stubWin = makeWin();
  ctx = vm.createContext({
    TextEncoder, TextDecoder, ReadableStream, Response, Request, Blob, atob, btoa, fetch,
    setTimeout, clearTimeout, setImmediate, queueMicrotask, Promise,
    chrome: { runtime: { connect: () => port } },
    window: stubWin,
    document: stubDoc,
    console: { log: () => {}, error: () => {}, warn: () => {} },
  });
  vm.runInContext(demoJs, ctx);
};

beforeEach(() => {
  demoJs = readFileSync('extension/debug/demo.js', 'utf8');
});

const deepApi = (): { chat: { completions: { create: (p: unknown) => Promise<unknown> } }; models: { list: () => Promise<unknown> } } =>
  (stubWin as any).deepApi;

const emit = (msg: ShimMsg): void => {
  const n = port.__listeners.length;
  process.stderr.write(`[emit] kind=${msg.__deepApi.kind} listeners=${n}\n`);
  port.__listeners.forEach(fn => fn(msg));
};

describe('chrome-extension:// shim (stream mode returns Response)', () => {
  it('stream:true 返回 Response，reader 能读到 SSE 帧并拼出 content', async () => {
    loadBundle();
    port.postMessage = (msg) => {
      const env = (msg as { __deepApi?: { id: number; method: string; params: { stream?: boolean } } }).__deepApi;
      if (!env) return;
      if (env.method === 'chat.completions.create' && env.params.stream) {
        const id = env.id;
        queueMicrotask(() => {
          emit({ __deepApi: { id, kind: 'chunk', chunk: { choices: [{ delta: { content: '你好' } }] } } });
          emit({ __deepApi: { id, kind: 'chunk', chunk: { choices: [{ delta: { content: '，世界' } }] } } });
          emit({ __deepApi: { id, kind: 'done' } });
        });
      } else if (env.method === 'models.list') {
        queueMicrotask(() => emit({ __deepApi: { id: env.id, kind: 'result', value: { data: [{ id: 'm1' }] } } }));
      }
    };
    const api = deepApi();
    expect(api).toBeTruthy();
    const res = await api.chat.completions.create({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res).toBeInstanceOf(Response);

    const reader = (res as Response).body!.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let content = '';
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        if (payload === '[DONE]') continue;
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
      }
    }
    expect(content).toBe('你好，世界');
  });

  it('non-stream 仍返回普通对象', async () => {
    loadBundle();
    port.postMessage = (msg) => {
      const env = (msg as { __deepApi?: { id: number; method: string; params: { stream?: boolean } } }).__deepApi;
      if (env?.method === 'chat.completions.create' && !env.params.stream) {
        queueMicrotask(() => emit({ __deepApi: { id: env.id, kind: 'result', value: { choices: [{ message: { content: 'pong' } }] } } }));
      }
    };
    const result = await deepApi().chat.completions.create({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(result).toEqual({ choices: [{ message: { content: 'pong' } }] });
  });

  it('SW 推 error 帧时 SSE 流里有 data:{error:...}\\n\\n', async () => {
    loadBundle();
    port.postMessage = (msg) => {
      const env = (msg as { __deepApi?: { id: number; method: string; params: { stream?: boolean } } }).__deepApi;
      if (env?.method === 'chat.completions.create' && env.params.stream) {
        queueMicrotask(() => emit({
          __deepApi: { id: env.id, kind: 'error', error: { error: { message: '未登录', type: 'api_error', code: 'provider_unavailable' } } },
        }));
      }
    };
    const res = await deepApi().chat.completions.create({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    const reader = (res as Response).body!.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let errorPayload: any = null;
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) errorPayload = j.error;
        } catch {}
      }
    }
    expect(errorPayload).toBeTruthy();
    expect(errorPayload.message).toBe('未登录');
  });
});