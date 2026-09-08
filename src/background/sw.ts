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

interface ProviderConfig { poolSize: number; ttlMinutes: number; lastAuthStatus?: { state: string; message?: string } }

async function getProviderConfig(providerId: string): Promise<ProviderConfig> {
  const got = (await STORAGE.get(`providers.${providerId}`)) as unknown as ProviderConfig | undefined;
  return { poolSize: got?.poolSize ?? 2, ttlMinutes: got?.ttlMinutes ?? 30, lastAuthStatus: got?.lastAuthStatus };
}
async function setProviderConfig(providerId: string, patch: Partial<ProviderConfig>): Promise<void> {
  const cur = await getProviderConfig(providerId);
  await STORAGE.set({ [`providers.${providerId}`]: { ...cur, ...patch } });
}
async function setAuthStatus(providerId: string, status: { state: string; message?: string }): Promise<void> {
  await setProviderConfig(providerId, { lastAuthStatus: status });
}

// 登录 token：content script 从 chat.deepseek.com localStorage 读到后通过 port 推送过来。
// 这里用内存缓存 + chrome.storage.local 持久化（SW 重启/整个浏览器重启都能恢复）。
let cachedToken: string | null = null;
async function loadCachedToken(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  const got = (await STORAGE.get({ authToken: '' })) as unknown as { authToken?: string } | undefined;
  cachedToken = got?.authToken ?? null;
  return cachedToken;
}
async function setCachedToken(t: string | null): Promise<void> {
  cachedToken = t;
  await STORAGE.set({ authToken: t ?? '' });   // 空字符串表示无 token
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
const panelPorts = new Set<chrome.runtime.Port>();   // 当前打开的 popup 面板 port

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
    getToken: async () => loadCachedToken(),
    fetchJson: async (path, headers, body) => {
      const t = await loadCachedToken();
      if (!t) throw Object.assign(new Error('no token'), { status: 401 });
      const r = await fetch(DEEPSEEK_API_BASE + path, {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${t}` }, credentials: 'include',
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error(`bad json: ${text.slice(0, 200)}`), { status: r.status }); }
      if (!r.ok) throw Object.assign(new Error(`http ${r.status}`), { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: parsed });
      return parsed;
    },
    fetchStream: async (path, headers, body) => {
      const t = await loadCachedToken();
      if (!t) throw Object.assign(new Error('no token'), { status: 401 });
      const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${t}` }, credentials: 'include', body: JSON.stringify(body) });
      if (!r.body) throw Object.assign(new Error(`no body http ${r.status}`), { status: r.status, headers: r.headers });
      return { status: r.status, headers: r.headers, body: r.body as unknown as AsyncIterable<Uint8Array> };
    },
    pow: new PowSolver({
      fetchJson: async (path, _h, body) => {
        const t = await loadCachedToken();
        const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers: authHeaders(t ?? ''), credentials: 'include', body: JSON.stringify(body) });
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
    storage: { get: async (k) => (await STORAGE.get(k as unknown as string))?.[k as unknown as string], set: async (k, v) => { await STORAGE.set({ [k]: v }); } },
    log,
    now: () => Date.now(),
  });
  cached = { router, log };
  return cached;
}

/** 用缓存 token 探测登录态（发一个 chat_session/create 再 delete）。 */
async function probeAuthStatus(): Promise<{ state: string; message?: string }> {
  const token = await loadCachedToken();
  if (!token) return { state: 'logged_out', message: '请在 chat.deepseek.com 登录账号' };
  try {
    const r = await fetch(`${DEEPSEEK_API_BASE}/chat_session/create`, {
      method: 'POST', headers: authHeaders(token), credentials: 'include', body: JSON.stringify({}),
    });
    if (r.status === 200 || r.status === 201) {
      try { const j: any = await r.json(); const id = j?.data?.chat_session?.id ?? j?.data?.chat_session_id; if (id) await fetch(`${DEEPSEEK_API_BASE}/chat_session/delete`, { method: 'POST', headers: authHeaders(token), credentials: 'include', body: JSON.stringify({ chat_session_id: id }) }); } catch { /* best-effort */ }
      return { state: 'logged_in' };
    }
    if (r.status === 401 || r.status === 403) return { state: 'expired', message: `登录失效（HTTP ${r.status}）` };
    return { state: 'expired', message: `探测失败：HTTP ${r.status}` };
  } catch (e) {
    return { state: 'expired', message: `探测异常：${(e as Error).message}` };
  }
}

async function refreshAuthAndLog(): Promise<void> {
  // 优先以当前缓存 token 探测（不再主动获取，依赖 content script 推送）
  const status = await probeAuthStatus();
  await setAuthStatus('deepseek', status);
  console.log('[deep.api] auth probe:', status);
  await broadcastPanelState();
}

async function broadcastPanelState(): Promise<void> {
  if (panelPorts.size === 0) return;
  try {
    const { router, log } = await build();
    const provCfg = await getProviderConfig('deepseek');
    const logList = (await STORAGE.get('log')) as unknown as { log?: any[] };
    const state = {
      providers: { deepseek: { ...provCfg, models: router.models ? (await router.models()).data : [] } },
      log: (logList?.log as any[]) ?? log.list(),
    };
    for (const p of panelPorts) {
      try { p.postMessage({ kind: 'state', payload: state }); } catch { /* port closed mid-broadcast */ }
    }
  } catch (e) { console.warn('[deep.api] broadcastPanelState failed', e); }
}

chrome.runtime.onInstalled.addListener(() => { void refreshAuthAndLog(); });
chrome.runtime.onStartup.addListener(() => { void refreshAuthAndLog(); });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'deepapi') {
    port.onMessage.addListener(async (msg: unknown) => {
      if (!isBridgeRequest(msg)) return;
      const env = (msg as { __deepApi: { id: number; method: string; params: unknown } }).__deepApi;

      // 来自 content script 的 auth.sync：直接吞掉，不走 Router
      if (env.method === 'auth.sync') {
        const params = env.params as { token: unknown };
        const newTok = typeof params?.token === 'string' && params.token.length > 0 ? params.token : null;
        const prev = await loadCachedToken();
        if (newTok !== prev) {
          await setCachedToken(newTok);
          console.log('[deep.api] token updated:', newTok ? newTok.slice(0, 12) + '...' : '(none)');
          // token 变化时立即探测一次 + 广播 popup
          await refreshAuthAndLog();
        }
        return;
      }

      const { router } = await build();
      try {
        const token = await loadCachedToken();
        if (!token) {
          const { error, status } = { error: { error: { message: '未登录 chat.deepseek.com，请先在浏览器中登录', type: 'api_error', code: 'provider_unavailable' } }, status: 503 };
          port.postMessage({ __deepApi: { id: env.id, kind: 'error', error } } as unknown as BridgeResponseMsg);
          return;
        }
        if (env.method === 'chat.completions.create') {
          const params = env.params as { stream?: boolean };
          const resp = await router.create(token, env.params as unknown);
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
          port.postMessage({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'models.list') {
          const models = await router.models();
          port.postMessage({ __deepApi: { id: env.id, kind: 'result', value: models } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'auth.requested') {
          // SW 不主动拉 token；仅返回当前缓存状态
          port.postMessage({ __deepApi: { id: env.id, kind: 'result', value: { token: await loadCachedToken() } } } as unknown as BridgeResponseMsg);
        }
      } catch (e) {
        const anyE = e as { error?: { error?: { message: string; type: string; code: string } }; status?: number };
        const errPayload = anyE.error && anyE.status !== undefined
          ? { error: anyE.error }
          : { error: { error: { message: (e as Error).message, type: 'api_error', code: 'internal_error' } } };
        port.postMessage({ __deepApi: { id: env.id, kind: 'error', error: errPayload.error } } as unknown as BridgeResponseMsg);
      }
    });
  } else if (port.name === 'deepapi-panel') {
    panelPorts.add(port);
    port.onDisconnect.addListener(() => { panelPorts.delete(port); });
    port.onMessage.addListener(async (msg: any) => {
      const { router, log } = await build();
      if (msg?.kind === 'panel.getState') {
        const provCfg = await getProviderConfig('deepseek');
        const logList = (await STORAGE.get('log')) as unknown as { log?: any[] };
        port.postMessage({
          kind: 'state',
          payload: {
            providers: {
              deepseek: { ...provCfg, models: router.models ? (await router.models()).data : [] },
            },
            log: (logList?.log as any[]) ?? log.list(),
          },
        });
      } else if (msg?.kind === 'panel.openLogin') {
        await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
      } else if (msg?.kind === 'panel.refreshAuth') {
        await refreshAuthAndLog();
        await broadcastPanelState();
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

export {};
