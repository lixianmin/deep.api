import type { ChatCompletion, ChatCompletionChunk, ModelInfo } from '../shared/api-types';
import { BridgeError } from '../shared/protocol';

declare global { interface Window { deepApi: unknown; deepApiConfig?: Record<string, unknown> } }

// Pending 内部仍接收 ChatCompletionChunk 对象（从 SW postMessage 过来），但在 streamHandle 内部序列化为 SSE 字符串输出
type Pending = { resolve(v: unknown): void; reject(e: unknown): void; onChunk(c: ChatCompletionChunk): void; onDone(): void; cancelled: boolean };

const AUTH_KEY = 'userToken';

// channel via window.postMessage（被 ISOLATED world 的 bridge-relay 转发到 SW）
let seq = 0;
function postRequest(method: string, params: unknown): number {
  const id = ++seq;
  window.postMessage({ __deepApi: { id, method, params } }, '*');
  return id;
}

// ---- token 同步（fire-and-forget，无响应）----
function readAuthToken(): string | null {
  try {
    const raw = window.localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === 'string' && parsed.value.length > 0 ? parsed.value : null;
  } catch (e) { console.warn('[deep.api bridge-main] readAuthToken parse error', e); return null; }
}
// 只在 chat.deepseek.com 上读取/推送 token：其他页面（如 example.com）的 localStorage 无 userToken，
// 推 null 会反复清空 SW 的 token 缓存导致 popup 登录态闪烁。
function shouldSyncAuth(): boolean {
  return location.hostname === 'chat.deepseek.com' || location.hostname.endsWith('.deepseek.com');
}
function pushAuth() {
  if (!shouldSyncAuth()) return;   // 非 deepseek 页面：只挂 API，不参与 token 同步
  const t = readAuthToken();
  console.log('[deep.api bridge-main] pushAuth token', t ? 'len=' + t.length : 'null');
  postRequest('auth.sync', { token: t });
}
if (shouldSyncAuth()) {
  pushAuth();
  window.addEventListener('storage', (ev: StorageEvent) => {
    if (ev.key === AUTH_KEY || ev.key === null) pushAuth();
  });
  const _origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string): void {
    _origSet.call(this, key, value);
    if (key === AUTH_KEY) pushAuth();
  };
  const _origRemove = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key: string): void {
    _origRemove.call(this, key);
    if (key === AUTH_KEY) pushAuth();
  };
  setInterval(pushAuth, 5000);
}

// ---- 响应包路由：page 上的 window message 来自 ISOLATED world 的 bridge-relay ----
const pending = new Map<number, Pending>();

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== null && ev.source !== window) return;
  const env = (ev.data as { __deepApi?: any } | undefined)?.__deepApi;
  if (!env || typeof env.id !== 'number') return;
  if (env.kind === undefined) return;   // 请求包（由 bridge-relay 转发，不在此处理）
  const p = pending.get(env.id);
  if (!p) return;
  if (env.kind === 'chunk') { if (!p.cancelled) p.onChunk(env.chunk as ChatCompletionChunk); return; }
  pending.delete(env.id);
  if (env.kind === 'done') {
    if (p.cancelled) p.reject(new BridgeError({ error: { message: 'cancelled', type: 'api_error', code: 'invalid_request_error' } }, 400));
    else p.onDone();
    return;
  }
  if (env.kind === 'error') {
    const code = env.error?.error?.code as string | undefined;
    const status = code === 'rate_limited' ? 429 : code === 'provider_unavailable' ? 503 : 400;
    p.reject(new BridgeError(env.error, status));
    return;
  }
  p.resolve(env.value);
});

function streamHandle(id: number) {
  // OpenAI SSE 兼容：yield 的是 `data: {json}\n\n` 字符串帧，不是 JS 对象。
  // bridge-main 在这里统一加上 SSE 帧边界 + 末尾 [DONE] 帧，让下游可以使用标准 SSE 解析器。
  const q: string[] = [];
  let settled = false;
  let wake: () => void = () => undefined;
  const notify = (): void => { const w = wake; wake = (): void => undefined; w(); };
  const p: Pending = {
    resolve: () => undefined,
    reject: () => undefined,
    onChunk: (c) => {
      try { q.push('data: ' + JSON.stringify(c) + '\n\n'); notify(); } catch { /* ignore unserializable */ }
    },
    onDone: () => { q.push('data: [DONE]\n\n'); settled = true; notify(); },
    cancelled: false,
  };
  pending.set(id, p);
  const iter = (async function* () {
    while (true) {
      while (q.length) yield q.shift()!;
      if (settled) return;
      await new Promise<void>((r) => { wake = r; });
    }
  })();
  return {
    [Symbol.asyncIterator]: () => iter,
    async cancel() { p.cancelled = true; try { postRequest('chat.completions.cancel', { requestId: id }); } catch { /* ignore */ } },
  };
}

// ---- 暴露给 page 的 API ----
const api = {
  chat: { completions: {
    create: (params: { model: string; messages: Array<{ role: string; content: string; [k: string]: unknown }>; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; conversation_id?: string; thinking?: boolean | null; search?: boolean; reasoning_effort?: 'low' | 'medium' | 'high' | 'max' }): Promise<ChatCompletion> | (AsyncIterable<string> & { cancel(): Promise<void> }) => {
      const id = postRequest('chat.completions.create', params);
      if (params.stream === true) return streamHandle(id);
      return new Promise<ChatCompletion>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, cancelled: false });
      });
    },
  } },
  models: { list: (): Promise<{ object: 'list'; data: ModelInfo[] }> => {
    const id = postRequest('models.list', {});
    return new Promise((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, cancelled: false }); });
  } },
};
Object.defineProperty(window, 'deepApi', { value: api, configurable: true, writable: true, enumerable: true });
console.log('[deep.api bridge-main] module loaded on', location.host, 'at', new Date().toISOString());
