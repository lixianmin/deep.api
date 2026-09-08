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
  // SW 环境下 await chrome.storage.local.get(singleKey) 返回的形状不稳定（实测返回裸值，丢掉 lastAuthStatus）；
  // 改用数组形式 get([key])，包裹层始终为 {key: value}，跟 callback 形式行为一致。
  const k = `providers.${providerId}`;
  const got = (await STORAGE.get([k])) as unknown as Record<string, ProviderConfig | undefined> | undefined;
  const cfg = got?.[k];
  return { poolSize: cfg?.poolSize ?? 2, ttlMinutes: cfg?.ttlMinutes ?? 30, lastAuthStatus: cfg?.lastAuthStatus };
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

// 主调用链路 header：与 probeHeaders 对齐（DeepSeek 对 X-Client-* / cookie 请求返回 HTML/401）
function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
/**
 * 探测用极简 header：DeepSeek 服务端对带 X-Client-* / cookie 的探测请求会 401，
 * 只发 Bearer + Content-Type 才能正常返回 200。
 */
function probeHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${t}` },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : null; } catch { throw Object.assign(new Error(`bad json: ${text.slice(0, 200)}`), { status: r.status }); }
      // DeepSeek 业务错误：HTTP 200 但顶层 code != 0（如 token 过期 code=401）——必须识别，
      // 否则 create_session 会报误导性的 "id missing" 而非"登录失效"。
      const biz = parsed as { code?: unknown } | null;
      if (biz && typeof biz.code === 'number' && biz.code !== 0) {
        const bizStatus = biz.code === 401 ? 401 : biz.code === 429 ? 429 : 400;
        throw Object.assign(new Error(`deepseek biz error code=${biz.code}: ${text.slice(0, 200)}`), { status: bizStatus, headers: Object.fromEntries(r.headers.entries()), body: parsed });
      }
      if (!r.ok) throw Object.assign(new Error(`http ${r.status}`), { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: parsed });
      return parsed;
    },
    fetchStream: async (path, headers, body) => {
      const t = await loadCachedToken();
      if (!t) throw Object.assign(new Error('no token'), { status: 401 });
      const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
      if (!r.body) throw Object.assign(new Error(`no body http ${r.status}`), { status: r.status, headers: r.headers });
      return { status: r.status, headers: r.headers, body: r.body as unknown as AsyncIterable<Uint8Array> };
    },
    pow: new PowSolver({
      fetchJson: async (path, _h, body) => {
        const t = await loadCachedToken();
        const r = await fetch(DEEPSEEK_API_BASE + path, { method: 'POST', headers: authHeaders(t ?? ''), body: JSON.stringify(body) });
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
      method: 'POST', headers: probeHeaders(token), body: JSON.stringify({}),
    });
    if (r.status === 200 || r.status === 201) {
      const j: any = await r.json();
      // 业务码检查：HTTP 200 但 code != 0 = 登录失效/业务错误
      if (j && typeof j.code === 'number' && j.code !== 0) {
        return { state: 'expired', message: `登录失效（业务 code=${j.code}，请重新登录 chat.deepseek.com）` };
      }
      try { const id = j?.data?.biz_data?.id ?? j?.data?.chat_session?.id ?? j?.data?.chat_session_id; if (id) await fetch(`${DEEPSEEK_API_BASE}/chat_session/delete`, { method: 'POST', headers: probeHeaders(token), body: JSON.stringify({ chat_session_id: id }) }); } catch { /* best-effort */ }
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
    // port 存活追踪：页面进 bfcache / 导航离开时 port 会被 Chrome 关闭，
    // 后续 postMessage 会抛 Unchecked runtime.lastError。所有发送都走 safePost。
    let portAlive = true;
    port.onDisconnect.addListener(() => { portAlive = false; });
    const safePost = (m: BridgeResponseMsg): boolean => {
      if (!portAlive) return false;
      try {
        port.postMessage(m as unknown as unknown);
        return true;
      } catch {
        portAlive = false;
        return false;
      }
    };
    port.onMessage.addListener(async (msg: unknown) => {
      if (!isBridgeRequest(msg)) return;
      const env = (msg as { __deepApi: { id: number; method: string; params: unknown } }).__deepApi;

      // 来自 content script 的 auth.sync：直接吞掉，不走 Router
      if (env.method === 'auth.sync') {
        const params = env.params as { token: unknown };
        const newTok = typeof params?.token === 'string' && params.token.length > 0 ? params.token : null;
        const prev = await loadCachedToken();
        // 防御：null token 不立即清缓存（可能来自非 deepseek 页面误推或 token 轮换瞬态），保留最后一次有效 token
        if (newTok === null && prev !== null) {
          console.log('[deep.api sw] auth.sync null ignored (keeping cached token)');
          return;
        }
        if (newTok !== prev) {
          await setCachedToken(newTok);
          console.log('[deep.api] token updated:', newTok ? newTok.slice(0, 12) + '...' : '(none)');
          await refreshAuthAndLog();
        }
        return;
      }

      const { router } = await build();
      try {
        const token = await loadCachedToken();
        if (!token) {
          const { error, status } = { error: { error: { message: '未登录 chat.deepseek.com，请先在浏览器中登录', type: 'api_error', code: 'provider_unavailable' } }, status: 503 };
          safePost({ __deepApi: { id: env.id, kind: 'error', error } } as unknown as BridgeResponseMsg);
          return;
        }
        if (env.method === 'chat.completions.create') {
          const params = env.params as { stream?: boolean };
          const resp = await router.create(token, env.params as unknown);
          if (params.stream) {
            const iter = resp as AsyncIterable<ChatCompletionChunk>;
            for await (const chunk of iter) {
              if (!safePost({ __deepApi: { id: env.id, kind: 'chunk', chunk } } as unknown as BridgeResponseMsg)) break;
            }
            safePost({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
          } else {
            safePost({ __deepApi: { id: env.id, kind: 'result', value: resp } } as unknown as BridgeResponseMsg);
          }
        } else if (env.method === 'chat.completions.cancel') {
          safePost({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'models.list') {
          const models = await router.models();
          safePost({ __deepApi: { id: env.id, kind: 'result', value: models } } as unknown as BridgeResponseMsg);
        } else if (env.method === 'auth.requested') {
          // SW 不主动拉 token；仅返回当前缓存状态
          safePost({ __deepApi: { id: env.id, kind: 'result', value: { token: await loadCachedToken() } } } as unknown as BridgeResponseMsg);
        }
      } catch (e) {
        const anyE = e as { error?: { error?: { message: string; type: string; code: string } }; status?: number };
        const errPayload = anyE.error && anyE.status !== undefined
          ? { error: anyE.error }
          : { error: { error: { message: (e as Error).message, type: 'api_error', code: 'internal_error' } } };
        safePost({ __deepApi: { id: env.id, kind: 'error', error: errPayload.error } } as unknown as BridgeResponseMsg);
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
      } else if (msg?.kind === 'panel.repushAuth') {
        // 强制对所有 chat.deepseek.com 标签页重新注入 content script（不需要用户手动 F5）
        try {
          const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
          console.log('[deep.api sw] repushAuth: found', tabs.length, 'chat.deepseek.com tab(s)');
          for (const t of tabs) {
            if (t.id !== undefined) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: t.id, allFrames: true },
                  files: ['bridge-main.js'],
                });
                console.log('[deep.api sw] repushAuth: re-injected into tab', t.id, t.url);
              } catch (e) { console.warn('[deep.api sw] repushAuth: failed for tab', t.id, e); }
            }
          }
        } catch (e) { console.warn('[deep.api sw] repushAuth error', e); }
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
