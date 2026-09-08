// src/background/sw.ts — MV3 service worker entry；chrome.* 仅在此文件
import { Router } from './router';
import { SessionMapper } from './session-mapper';
import { Queue } from './queue';
import { RingLog } from './log';
import { createDeepSeekAdapter, type AdapterDeps } from './providers/deepseek/adapter';
import { PowSolver, instantiateDeepSeekWasm, type WasmInstance } from './providers/deepseek/pow';
import { isBridgeRequest, type BridgeResponseMsg } from '../shared/protocol';
import type { ChatCompletionChunk } from '../shared/api-types';
import { createRegistry } from './providers/registry';

const STORAGE = chrome.storage.local;
const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api/v0';
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

async function ensureApiKey(): Promise<string> {
  const got = (await STORAGE.get('apiKey')) as { apiKey?: string };
  if (got.apiKey) return got.apiKey;
  const key = 'sk-dapi-' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  await STORAGE.set({ apiKey: key });
  return key;
}

async function getProviderConfig(providerId: string): Promise<{ poolSize: number; ttlMinutes: number }> {
  const got = (await STORAGE.get(`providers.${providerId}`)) as unknown as { poolSize?: number; ttlMinutes?: number } | undefined;
  return { poolSize: got?.poolSize ?? 2, ttlMinutes: got?.ttlMinutes ?? 30 };
}

async function setProviderConfig(providerId: string, patch: Partial<{ poolSize: number; ttlMinutes: number }>): Promise<void> {
  const cur = await getProviderConfig(providerId);
  await STORAGE.set({ [`providers.${providerId}`]: { ...cur, ...patch } });
}

async function getLastAuth(providerId: string): Promise<{ state: string; message?: string } | undefined> {
  const got = (await STORAGE.get(`providers.${providerId}.lastAuthStatus`)) as unknown as { lastAuthStatus?: { state: string; message?: string } } | undefined;
  return got?.lastAuthStatus;
}

async function getCookieToken(): Promise<string | null> {
  const got = await chrome.cookies.get({ url: 'https://chat.deepseek.com/', name: 'user_token' });
  return got?.value ?? null;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Client-Version': '2.0.0',
    'X-Client-Platform': 'android',
    'X-Client-Locale': 'zh_CN',
    'Content-Type': 'application/json',
  };
}

let cached: { router: Router; log: RingLog } | null = null;

async function build(): Promise<{ router: Router; log: RingLog }> {
  if (cached) return cached;
  const log = new RingLog(20);
  const cfg = await getProviderConfig('deepseek');
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: '' }), deleteSession: async () => {}, now: () => Date.now() },
    { poolSize: cfg.poolSize, ttlMs: cfg.ttlMinutes * 60_000 },
  );
  let wasmInst: Promise<WasmInstance> | null = null;
  async function getWasm(): Promise<WasmInstance> {
    if (!wasmInst) wasmInst = (async () => {
      const r = await fetch(WASM_URL, { credentials: 'include' });
      const buf = await r.arrayBuffer();
      return instantiateDeepSeekWasm(new Uint8Array(buf));
    })();
    return wasmInst;
  }
  const deps: AdapterDeps = {
    getToken: getCookieToken,
    fetchJson: async (path, headers, body) => {
      const init: RequestInit = {
        method: 'POST',
        headers,
        credentials: 'include',
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      };
      const r = await fetch(DEEPSEEK_API_BASE + path, init);
      const text = await r.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error(`bad json: ${text.slice(0, 200)}`), { status: r.status }); }
      if (!r.ok) throw Object.assign(new Error(`http ${r.status}`), { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: parsed });
      return parsed;
    },
    fetchStream: async (path, headers, body) => {
      const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) });
      if (!r.body) throw Object.assign(new Error(`no body http ${r.status}`), { status: r.status, headers: r.headers });
      return { status: r.status, headers: r.headers, body: r.body as unknown as AsyncIterable<Uint8Array> };
    },
    pow: new PowSolver({
      fetchJson: async (path, _h, body) => {
        const token = await getCookieToken() ?? '';
        const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers: authHeaders(token), credentials: 'include', body: JSON.stringify(body) });
        return r.json();
      },
      fetchBytes: async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        const buf = await r.arrayBuffer();
        return new Uint8Array(buf);
      },
      instantiate: getWasm,
      wasmUrl: WASM_URL,
    }),
    now: () => Date.now(),
  };
  const adapter = createDeepSeekAdapter(deps);
  const router = new Router({
    registry: createRegistry(adapter),
    mapper,
    queue: new Queue({ timeoutMs: 60_000 }),
    storage: {
      get: async (k) => (await STORAGE.get(k as unknown as string))?.[k as unknown as string],
      set: async (k, v) => { await STORAGE.set({ [k]: v }); },
    },
    log,
    now: () => Date.now(),
    ensureKey: ensureApiKey,
  });
  cached = { router, log };
  return cached;
}

// 启动
ensureApiKey().catch(() => undefined);

// cookie 变更 -> 标记登录态
chrome.cookies.onChanged.addListener(async (info) => {
  if (info.cookie.domain.includes('chat.deepseek.com') && info.cookie.name === 'user_token' && info.removed) {
    await STORAGE.set({ 'providers.deepseek.lastAuthStatus': { state: 'expired', message: 'cookie removed' } });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'deepapi') {
    port.onMessage.addListener(async (msg: unknown) => {
      if (!isBridgeRequest(msg)) return;
      const env = (msg as { __deepApi: { id: number; method: string; params: unknown } }).__deepApi;
      const { router } = await build();
      try {
        if (env.method === 'chat.completions.create') {
          const params = env.params as { stream?: boolean };
          const resp = await router.create(env.params as unknown);
          if (params.stream) {
            const iter = resp as AsyncIterable<ChatCompletionChunk>;
            for await (const chunk of iter) {
              port.postMessage({ __deepApi: { id: env.id, kind: 'chunk', chunk } } as unknown as BridgeResponseMsg);
            }
            port.postMessage({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
          } else {
            port.postMessage({ __deepApi: { id: env.id, kind: 'result', value: resp } } as unknown as BridgeResponseMsg);
          }
        } else if (env.method === 'chat.completions.cancel') {
          // best-effort: per-stream cancel 未来增强
          port.postMessage({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'models.list') {
          const models = await router.models();
          port.postMessage({ __deepApi: { id: env.id, kind: 'result', value: models } } as unknown as BridgeResponseMsg);
        }
      } catch (e) {
        const errPayload = (e as { error?: { error?: { message: string; type: string; code: string } }; status?: number }).error && (e as any).status !== undefined
          ? { error: (e as any).error, status: (e as any).status }
          : { error: { error: { message: (e as Error).message, type: 'api_error', code: 'internal_error' } }, status: 500 };
        port.postMessage({ __deepApi: { id: env.id, kind: 'error', error: errPayload.error } } as unknown as BridgeResponseMsg);
      }
    });
  } else if (port.name === 'deepapi-panel') {
    port.onMessage.addListener(async (msg: any) => {
      const { router, log } = await build();
      if (msg?.kind === 'panel.getState') {
        const apiKey = (await STORAGE.get('apiKey')) as unknown as string;
        const provCfg = await getProviderConfig('deepseek');
        const lastAuth = (await getLastAuth('deepseek')) ?? { state: 'logged_out' };
        const logList = (await STORAGE.get('log')) as unknown as { log?: any[] };
        port.postMessage({ kind: 'state', payload: {
          apiKey,
          providers: { deepseek: { ...provCfg, lastAuthStatus: lastAuth } },
          log: (logList?.log as any[]) ?? log.list(),
        } });
      } else if (msg?.kind === 'panel.openLogin') {
        await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
      } else if (msg?.kind === 'panel.regenerateKey') {
        const key = 'sk-dapi-' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        await STORAGE.set({ apiKey: key });
        port.postMessage({ kind: 'state', payload: { apiKey: key } });
      } else if (msg?.kind === 'panel.setPool') {
        await setProviderConfig('deepseek', { poolSize: msg.payload.poolSize });
      } else if (msg?.kind === 'panel.setTtl') {
        await setProviderConfig('deepseek', { ttlMinutes: msg.payload.ttlMinutes });
      } else if (msg?.kind === 'panel.listLogs') {
        port.postMessage({ kind: 'state', payload: { log: log.list() } });
      } else if (msg?.kind === 'ping') {
        port.postMessage({ kind: 'pong' });
      }
    });
  }
});

export {};   // MV3 service worker module marker
