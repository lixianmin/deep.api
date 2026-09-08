import type { ChatCompletion, ChatCompletionChunk, ModelInfo } from '../shared/api-types';
import { BridgeError } from '../shared/protocol';

declare global { interface Window { deepApi: unknown; deepApiConfig?: Record<string, unknown> } }

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; onChunk(c: ChatCompletionChunk): void; onDone(): void; cancelled: boolean };

const AUTH_KEY = 'userToken';

/** 从 chat.deepseek.com localStorage 解析当前 userToken，格式 {"value":"<JWT>","__version":"0"}。 */
function readAuthToken(): string | null {
  try {
    const raw = window.localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === 'string' && parsed.value.length > 0 ? parsed.value : null;
  } catch { return null; }
}

export function bridgeMainFactory(target: Window): void {
  let seq = 0;
  const pending = new Map<number, Pending>();
  type Method = 'chat.completions.create' | 'chat.completions.cancel' | 'models.list' | 'auth.sync' | 'auth.requested';
  const send = (method: Method, params: unknown): number => {
    const id = ++seq;
    target.postMessage({ __deepApi: { id, method, params } }, '*');
    return id;
  };

  target.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== null && ev.source !== target) return;
    const env = (ev.data as { __deepApi?: any } | undefined)?.__deepApi;
    if (!env || typeof env.id !== 'number') return;
    if (env.kind === undefined) return;
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
    const q: ChatCompletionChunk[] = [];
    let settled = false;
    let wake: () => void = () => undefined;
    const notify = (): void => { const w = wake; wake = (): void => undefined; w(); };
    const p: Pending = {
      resolve: () => undefined,
      reject: () => undefined,
      onChunk: (c) => { q.push(c); notify(); },
      onDone: () => { settled = true; notify(); },
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
      async cancel() { p.cancelled = true; send('chat.completions.cancel', { requestId: id }); },
    };
  }

  const api = {
    chat: { completions: {
      create: (params: { model: string; messages: Array<{ role: string; content: string; [k: string]: unknown }>; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; conversation_id?: string }): Promise<ChatCompletion> | (AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> }) => {
        const id = send('chat.completions.create', params);
        if (params.stream === true) return streamHandle(id);
        return new Promise<ChatCompletion>((resolve, reject) => {
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, cancelled: false });
        });
      },
    } },
    models: { list: (): Promise<{ object: 'list'; data: ModelInfo[] }> => {
      const id = send('models.list', {});
      return new Promise((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => undefined, onDone: () => undefined, cancelled: false }); });
    } },
  };
  Object.defineProperty(target, 'deepApi', { value: api, configurable: true, writable: true, enumerable: true });

  // Auth 同步：start + storage 事件 + 监听 setItem/removeItem 兜底 + 5s 心跳
  function pushAuth() { send('auth.sync', { token: readAuthToken() }); }
  pushAuth();
  target.addEventListener('storage', (ev: StorageEvent) => {
    if (ev.key === AUTH_KEY || ev.key === null) pushAuth();
  });
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string): void {
    origSet.call(this, key, value);
    if (key === AUTH_KEY) pushAuth();
  };
  const origRemove = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key: string): void {
    origRemove.call(this, key);
    if (key === AUTH_KEY) pushAuth();
  };
  setInterval(pushAuth, 5000);
}

bridgeMainFactory(window as Window);
