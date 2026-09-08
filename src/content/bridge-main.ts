import type { ChatCompletion, ChatCompletionChunk, ModelInfo } from '../shared/api-types';
import { BridgeError } from '../shared/protocol';

declare global { interface Window { deepApi: unknown; deepApiConfig?: Record<string, unknown> } }

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; onChunk(c: ChatCompletionChunk): void; onDone(): void; cancelled: boolean };

export function bridgeMainFactory(target: Window): void {
  let seq = 0;
  const pending = new Map<number, Pending>();
  const send = (method: 'chat.completions.create' | 'chat.completions.cancel' | 'models.list', params: unknown): number => {
    const id = ++seq;
    target.postMessage({ __deepApi: { id, method, params } }, '*');
    return id;
  };
  target.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== null && ev.source !== target) return;
    const env = (ev.data as { __deepApi?: any } | undefined)?.__deepApi;
    if (!env || typeof env.id !== 'number') return;
    if (env.kind === undefined) return;   // 请求包由 relay 转发
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

  function streamHandle(id: number): AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> } {
    const q: ChatCompletionChunk[] = [];
    let settled = false;
    let wake: () => void = () => {};
    const notify = () => { const w = wake; wake = () => {}; w(); };
    const p: Pending = {
      resolve: () => {}, reject: () => {},
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

  // 本机桥接，无 API Key；window.deepApiConfig 仅用于高级覆盖（暂未启用）。
  const api = {
    chat: { completions: {
      create: (params: { model: string; messages: Array<{ role: string; content: string; [k: string]: unknown }>; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; conversation_id?: string }): Promise<ChatCompletion> | (AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> }) => {
        const id = send('chat.completions.create', params);
        if (params.stream === true) return streamHandle(id);
        return new Promise<ChatCompletion>((resolve, reject) => {
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => {}, onDone: () => {}, cancelled: false });
        });
      },
    } },
    models: { list: (): Promise<{ object: 'list'; data: ModelInfo[] }> => {
      const id = send('models.list', {});
      return new Promise((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => {}, onDone: () => {}, cancelled: false }); });
    } },
  };
  Object.defineProperty(target, 'deepApi', { value: api, configurable: true, writable: true, enumerable: true });
}

// 内容脚本入口：自动在当前 window 上挂载 deepApi
bridgeMainFactory(window as Window);
