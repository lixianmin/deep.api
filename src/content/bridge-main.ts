import type { ChatCompletion, ChatCompletionChunk, ModelInfo } from '../shared/api-types';
import { BridgeError } from '../shared/protocol';

declare global { interface Window { deepApi: unknown; deepApiConfig?: Record<string, unknown> } }

/** 公共：OpenAI Chat Completions SSE 帧序列构造。供 bridge-main + 独立测试使用。 */
export function sseChunkFrame(c: ChatCompletionChunk): string { return 'data: ' + JSON.stringify(c) + '\n\n'; }
export function sseErrorFrame(err: { error?: { message?: string; code?: string } }): string { return 'data: ' + JSON.stringify({ error: err.error ?? { message: 'unknown', code: 'internal_error' } }) + '\n\n'; }
export function sseDoneFrame(): string { return 'data: [DONE]\n\n'; }

// Pending 内部仍接收 ChatCompletionChunk 对象（从 SW postMessage 过来），但在 streamHandle 内部序列化为 SSE 字符串输出
type Pending = {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onChunk(c: ChatCompletionChunk): void;
  onDone(): void;
  /** 流式错误：推 SSE error 帧 + [DONE] 让 consumer for-await 正常退出。 */
  onError(err: { error?: { message?: string; code?: string } }): void;
  cancelled: boolean;
};

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
    // 流式路径：推 SSE error 帧 + [DONE]让 consumer for-await 正常退出（不是 hang）
    if ('onError' in p && (p as Pending).onError) { (p as Pending).onError(env.error); return; }
    // 非流式路径：reject promise
    const code = env.error?.error?.code as string | undefined;
    const status = code === 'rate_limited' ? 429 : code === 'provider_unavailable' ? 503 : 400;
    p.reject(new BridgeError(env.error, status));
    return;
  }
  p.resolve(env.value);
});

function streamHandle(id: number) {
  // OpenAI SSE 契约：stream:true 返回值必须是 Response-like（含 body.getReader，content-type: text/event-stream），
  // 下游可用标准 SSE 解析器读 data: {json}\n\n 帧（spec §3 Shape B）。v0.1.49 修复——之前返回 AsyncIterable<string>
  // 使下游（如 spice parseDeepApiSse）判定非 Response，fall back 到 parseDeepApiJson 得空响应 → 「AI 无回复」。
  const Q_MAX = 1024;  // 背压：限制队列长度，模型推太快防止 OOM
  const q: string[] = [];
  let settled = false;
  let settleMode: 'done' | 'error' | 'cancel' = 'done';
  let wake: () => void = () => undefined;
  const notify = (): void => { const w = wake; wake = (): void => undefined; w(); };
  const push = (frame: string): void => {
    if (settled) return;  // settled 后不再入队
    if (q.length >= Q_MAX) q.shift();  // 背压：丢最老帧（极端场景：模型推极快、consumer 极慢）
    q.push(frame);
    notify();
  };
  const p: Pending = {
    resolve: () => undefined,
    reject: () => undefined,
    onChunk: (c) => {
      if (settled) return;
      try { push(sseChunkFrame(c)); } catch { /* ignore unserializable */ }
    },
    onDone: () => {
      if (settled) return;
      push(sseDoneFrame());
      settled = true;
      settleMode = 'done';
      notify();
    },
    // 流式错误：推 SSE error 帧 + [DONE]，让 consumer for-await 正常结束（不是 hang）
    onError: (err: { error?: { message?: string; code?: string } }) => {
      if (settled) return;
      try { push(sseErrorFrame(err)); } catch { /* ignore */ }
      push(sseDoneFrame());
      settled = true;
      settleMode = 'error';
      notify();
    },
    cancelled: false,
  };
  pending.set(id, p);
  const iter = (async function* () {
    while (true) {
      while (q.length) yield q.shift()!;
      if (settled) {
        // 错误/done/cancel 都静默退出（error/cancel 帧已推给 consumer）— 避免 consumer for-await hang
        if (settleMode as string === 'error') { /* 静默退出：error 帧已让 consumer 知道 */ }
        return;
      }
      await new Promise<void>((r) => { wake = r; });
    }
  })();
  // 把 AsyncIterable<string> 包装成 Response（spec §3 Shape B：body.getReader + text/event-stream）。
  // pull() 每次从 iter 取一帧编码入队；consumer 用 reader.read() 读到 Uint8Array 后自行 decode。
  // 错误/cancel/done 都会推 [DONE] 帧，iter 自然结束 → controller.close()。
  // stream.cancel() 触发 SW cancel + 推 [DONE]（避免 consumer hang）。
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next();
        if (done) { controller.close(); return; }
        controller.enqueue(encoder.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      p.cancelled = true;
      try { postRequest('chat.completions.cancel', { requestId: id }); } catch { /* ignore */ }
      // cancel 后若还卡住（SW 未发 done），主动 settled
      if (!settled) {
        push(sseDoneFrame());
        settled = true;
        settleMode = 'cancel';
        notify();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

// ---- 暴露给 page 的 API ----
const api = {
  chat: { completions: {
    create: (params: { model: string; messages: Array<{ role: string; content: string; [k: string]: unknown }>; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; conversation_id?: string; thinking?: boolean | null; search?: boolean; reasoning_effort?: 'low' | 'medium' | 'high' | 'max' }): Promise<ChatCompletion> | (AsyncIterable<string> & { cancel(): Promise<void> }) => {
      const id = postRequest('chat.completions.create', params);
      if (params.stream === true) return streamHandle(id);
      return new Promise<ChatCompletion>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, onError: () => undefined, cancelled: false });
      });
    },
  } },
  models: { list: (): Promise<{ object: 'list'; data: ModelInfo[] }> => {
    const id = postRequest('models.list', {});
    return new Promise((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, onError: () => undefined, cancelled: false }); });
  } },
};
Object.defineProperty(window, 'deepApi', { value: api, configurable: true, writable: true, enumerable: true });
console.log('[deep.api bridge-main] module loaded on', location.host, 'at', new Date().toISOString());
