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
const DEEPSEEK_COOKIE_DOMAIN = '.chat.deepseek.com';   // chrome.cookies 需要带 . 前缀
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const AUTH_POLL_ALARM = 'deep.api.auth.poll';
const AUTH_POLL_MINUTES = 1;

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

/** 取第一个能找到的 DeepSeek 登录 cookie。多个候选名（spike #2 校准）。 */
async function getDeepSeekToken(): Promise<string | null> {
  for (const name of ['user_token', 'ds_session', 'sessionid']) {
    try {
      const c = await chrome.cookies.get({ url: 'https://chat.deepseek.com/', name });
      if (c?.value) return c.value;
    } catch { /* fallthrough */ }
  }
  return null;
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
    getToken: getDeepSeekToken,
    fetchJson: async (path, headers, body) => {
      const r = await fetch(DEEPSEEK_API_BASE + path, {
        method: 'POST', headers, credentials: 'include',
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
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
        const token = await getDeepSeekToken() ?? '';
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
    storage: { get: async (k) => (await STORAGE.get(k as unknown as string))?.[k as unknown as string], set: async (k, v) => { await STORAGE.set({ [k]: v }); } },
    log,
    now: () => Date.now(),
  });
  cached = { router, log };
  return cached;
}

/** 主动探测登录状态：取 token + create_session + delete_session，成功则 logged_in。 */
async function probeAuthStatus(): Promise<{ state: string; message?: string }> {
  const token = await getDeepSeekToken();
  if (!token) return { state: 'logged_out' };
  try {
    const r = await fetch(`${DEEPSEEK_API_BASE}/chat_session/create`, {
      method: 'POST',
      headers: authHeaders(token),
      credentials: 'include',
      body: JSON.stringify({}),
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

// 启动：注册 cookie 监听 + 周期探测
chrome.cookies.onChanged.addListener(async (info) => {
  if (!info.cookie.domain.includes('chat.deepseek.com')) return;
  if (!['user_token', 'ds_session', 'sessionid'].includes(info.cookie.name)) return;
  if (info.removed) await setAuthStatus('deepseek', { state: 'expired', message: 'cookie 已失效，请重新登录 chat.deepseek.com' });
  else await setAuthStatus('deepseek', await probeAuthStatus());
  await broadcastPanelState();
});

chrome.runtime.onInstalled.addListener(() => { void refreshAuthAndLog(); });
chrome.runtime.onStartup.addListener(() => { void refreshAuthAndLog(); });

async function refreshAuthAndLog(): Promise<void> {
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

chrome.alarms.create(AUTH_POLL_ALARM, { periodInMinutes: AUTH_POLL_MINUTES });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === AUTH_POLL_ALARM) await refreshAuthAndLog();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'deepapi') {
    port.onMessage.addListener(async (msg: unknown) => {
      if (!isBridgeRequest(msg)) return;
      const env = (msg as { __deepApi: { id: number; method: string; params: unknown } }).__deepApi;
      const { router } = await build();
      try {
        const token = await getDeepSeekToken();
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
          // best-effort: per-stream cancel 未来增强
          port.postMessage({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'models.list') {
          const models = await router.models();
          port.postMessage({ __deepApi: { id: env.id, kind: 'result', value: models } } as unknown as BridgeResponseMsg);
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
