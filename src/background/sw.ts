// src/background/sw.ts — MV3 service worker entry；chrome.* 仅在此文件
import { Router } from './router';
import { SessionMapper, type ThreadEntry } from './session-mapper';
import { Queue } from './queue';
import { RingLog } from './log';
import { createDeepSeekAdapter, type AdapterDeps } from './providers/deepseek/adapter';
import { PowSolver, instantiateDeepSeekWasm, type WasmInstance } from './providers/deepseek/pow';
import { isBridgeRequest, BridgeError, type BridgeResponseMsg } from '../shared/protocol';
import type { ChatCompletionChunk } from '../shared/api-types';
import { createRegistry } from './providers/registry';
// 2026-09-14（fix/models-v4-retired）：`onCatalogUpdate` 不再用——仅 register-catalog-listener.ts 调用。
import { registerCatalogListener } from './register-catalog-listener';

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

let cached: { router: Router; log: RingLog; mapper: SessionMapper } | null = null;
const panelPorts = new Set<chrome.runtime.Port>();   // 当前打开的 popup 面板 port

/** 2026-09-11（fix/review-r1）：SessionMapper 的 deleteSession 真实现。
 *  旧注入是 `async () => {}`，mapper.fail() / TTL 过期 / LRU 淘汰承诺的 best-effort deleteSession
 *  在生产全是 no-op，DeepSeek 网页侧残留会话越堆越多（spec §4.3 要求保持网页侧干净）。 */
async function deleteDeepSeekSession(webSessionId: string): Promise<void> {
  try {
    const t = await loadCachedToken();
    if (!t || !webSessionId) return;
    await fetch(`${DEEPSEEK_API_BASE}/chat_session/delete`, {
      method: 'POST', headers: probeHeaders(t), body: JSON.stringify({ chat_session_id: webSessionId }),
    });
  } catch { /* best-effort：SW 随时可能被回收，删除失败不阻塞后续流程（spec §4.3） */ }
}

async function build(): Promise<{ router: Router; log: RingLog; mapper: SessionMapper }> {
  if (cached) return cached;
  const log = new RingLog(500);   // 2026-09-09（feat/debug-dashboard）调到 500：debug 页日志 tab 看更多决策现场
  const cfg = await getProviderConfig('deepseek');
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: '' }), deleteSession: deleteDeepSeekSession, now: () => Date.now() },
    { poolSize: cfg.poolSize, ttlMs: cfg.ttlMinutes * 60_000 },
  );
  // 2026-09-09（fix/thread-persistence）：threads 走数据层（chrome.storage.local），不依赖进程内存。
  // 重装扩展/刷新 spice 页面（MV3 SW 终止重启）后从数据层恢复 → 同 spice chat thread 仍对应
  // DeepSeek 网页端**同一个** Chat thread（webSessionId + parentMessageId 链不丢）。
  // 注意：用户明确要求状态以数据层为准，而不是进程状态。
  mapper.onPersist = (snap) => { void STORAGE.set({ 'threads.v1': snap }); };
  try {
    const got = (await STORAGE.get('threads.v1')) as unknown;
    const snap = (got as { 'threads.v1'?: { seq: number; threads: ThreadEntry[] } } | undefined)?.['threads.v1'];
    if (snap && Array.isArray(snap.threads)) mapper.restore(snap);
  } catch { /* 持久化数据损坏：放弃恢复，走 rebuild 安全路径 */ }
  // 2026-09-09（fix/evict-expired）：TTL 默认 30min（来自 ProviderConfig.ttlMinutes）。
  // restore 之后立即 sweep 一次——清掉 restore 进来的过期 thread，
  // 避免 SW 长时间没重启后 storage 里堆陈旧数据（chrome.storage 容量有界）。
  // 周期性 sweep（每 60s）由 commit 路径 setTimeout 触发，详见 evictExpired 调用点。
  await mapper.evictExpired('deepseek');
  let wasmInst: Promise<WasmInstance> | null = null;
  /** 2026-09-11（fix/review-r1）：接收 PowSolver.fetchBytes 已下载的字节，避免同一 wasm 下载两遍；
   *  实例化失败不落缓存（一次 CDN 抖动不再让整个 SW 生命周期的 PoW 全挂）。 */
  function getWasm(bytes: Uint8Array): Promise<WasmInstance> {
    if (!wasmInst) {
      const p = instantiateDeepSeekWasm(bytes);
      wasmInst = p;
      p.catch(() => { if (wasmInst === p) wasmInst = null; });
    }
    return wasmInst;
  }
  const deps: AdapterDeps = {
    getToken: async () => loadCachedToken(),
    // 2026-09-09（feat/vision-multimodal）：原始 fetch（不 stringify body）—— file upload（multipart）
    // + poll file ready（GET）。与 fetchJson 区别：不限定 POST、不 JSON.stringify、返回原始响应包装
    // （status + json/text 方法）。详见 docs/superpowers/specs/2026-09-09-vision-multimodal-design.md §4。
    fetchRaw: async (path, headers, init) => {
      const t = await loadCachedToken();
      if (!t) throw Object.assign(new Error('no token'), { status: 401 });
      const r = await fetch(DEEPSEEK_API_BASE + path, {
        method: init?.method || 'GET',
        headers: { ...headers, Authorization: `Bearer ${t}` },
        body: init?.body as BodyInit | undefined,
      });
      return {
        status: r.status,
        json: async () => { try { return await r.json(); } catch { return null; } },
        text: async () => r.text(),
      };
    },
    fetchJson: async (path, headers, body) => {
      const t = await loadCachedToken();
      if (!t) throw Object.assign(new Error('no token'), { status: 401 });
      const r = await fetch(DEEPSEEK_API_BASE + path, {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${t}` },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
      // v0.1.83 修复：fc4d10e（vision）误删了这行 `const text = await r.text();`，
      // 下方 3 处 `text` 引用全部变成 ReferenceError: text is not defined——
      // 所有 fetchJson 调用（create_session / delete_session / pow）运行时必抛，
      // 导致 chat 完全无响应且 DeepSeek 端看不到 thread。esbuild 不做类型检查所以 build 通过。
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
    queue: new Queue({ timeoutMs: 60_000, concurrency: cfg.poolSize }),
    storage: { get: async (k) => (await STORAGE.get(k as unknown as string))?.[k as unknown as string], set: async (k, v) => { await STORAGE.set({ [k]: v }); } },
    log,
    now: () => Date.now(),
    // 2026-09-09（diag/version-stamp）：manifest version 写入每条 log，日志自证构建版本。
    version: chrome.runtime.getManifest().version,
  });
  // 2026-09-09（feat/debug-dashboard）：注入 log 给 mapper，让 listThreads() 能按 cid 聚合最近一次决策现场。
  // 单实例仅一次；重复 build 命中 cached 短路。
  if (!mapper.log) mapper.log = log;
  cached = { router, log, mapper };
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

// 2026-09-10（fix/sw-vision-error）：任何未捕获的 promise rejection（port.onMessage async listener
// 中 router.create 拋错但未被 catch）都作为 provider_unavailable 发回 bridge，避免 SW console 静默
// 误导调试。Chrome MV3 SW 默认不会 console.error unhandledrejection。
self.addEventListener('unhandledrejection', (ev) => {
  const e = ev.reason as unknown;
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[deep.api sw] unhandled rejection:', msg);
});

// 2026-09-10（feat/models-sync fix-r1）：spec §3.6 content script → SW catalog push.
// chrome.runtime.onMessage 是另一条通道（独立于 bridge 的 port.onMessage）。
registerCatalogListener();

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
    // 2026-09-11（fix/review-r1）：在途流句柄表——env.id（create 的页面侧 id）→ 可取消的流。
    // 旧实现 cancel 分支完全忽略 params.requestId 且从不调用 router 的 stopStream（编码流的
    // cancel() 是唯一调用点），取消等于没取消：DeepSeek 侧继续生成、mirror 继续 commit。
    const inflightStreams = new Map<number, { aborted: boolean; cancel: () => Promise<void> }>();
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

      // 2026-09-11（fix/review-r1）：build() 移进 try——旧代码在 try 之外 await build()，
      // storage 读失败/构建异常会让整个监听器 reject（unhandledrejection），调用方永远等不到回包。
      try {
        const { router } = await build();
        const token = await loadCachedToken();
        if (!token) {
          const { error, status } = { error: { error: { message: '未登录 chat.deepseek.com，请先在浏览器中登录', type: 'api_error', code: 'provider_unavailable' } }, status: 503 };
          safePost({ __deepApi: { id: env.id, kind: 'error', error } } as unknown as BridgeResponseMsg);
          return;
        }
        // 2026-09-14（fix/models-v4-retired）：删除 models-catalog:update 死分支。
        // content script 走 chrome.runtime.sendMessage（registerCatalogListener 接听），
        // 桥接 port 不再有该方法的合法调用方。深先 2026-09-10 原有 plan error 误以为是补口。
        if (env.method === 'chat.completions.create') {
          // 2026-09-10（fix/sw-vision-error）：vision pipeline 拋错不应让 listener 整个 reject
          // 变 unhandledrejection（Chrome MV3 SW 不默认 console.error）。明确 try/catch + 发
          // kind:'error' 给 bridge + 写 log entry。
          try {
            const params = env.params as { stream?: boolean };
            const resp = await router.create(token, env.params as unknown);
            if (params.stream) {
              const handle = resp as AsyncIterable<ChatCompletionChunk> & { cancel?: () => Promise<void> };
              const entry = { aborted: false, cancel: async () => { try { await handle.cancel?.(); } catch { /* best effort */ } } };
              inflightStreams.set(env.id, entry);
              try {
                for await (const chunk of handle) {
                  // 被 cancel 后停止推送并破坏生成器：IteratorClose 会触发 router 的 finally
                  // （队列锁释放 + provider 流关闭 + 未 commit 的线程销毁）。
                  if (entry.aborted) break;
                  if (!safePost({ __deepApi: { id: env.id, kind: 'chunk', chunk } } as unknown as BridgeResponseMsg)) break;
                }
                safePost({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
              } finally {
                inflightStreams.delete(env.id);
              }
            } else {
              safePost({ __deepApi: { id: env.id, kind: 'result', value: resp } } as unknown as BridgeResponseMsg);
            }
          } catch (e) {
            // 2026-09-10（fix/sw-vision-error）：router.create 拋错（vision pipeline / stream / tool parse）
            // 都变 BridgeError。透传给 bridge 走 SSE error 帧 + [DONE]（不 hang consumer）。
            const be = e instanceof BridgeError ? e : new BridgeError({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error', code: 'provider_unavailable' } }, 500);
            console.error('[deep.api sw] chat.completions.create failed:', be.error.error.message);
            safePost({ __deepApi: { id: env.id, kind: 'error', error: be.error } } as unknown as BridgeResponseMsg);
          }
        } else if (env.method === 'chat.completions.cancel') {
          // 2026-09-11（fix/review-r1）：按 params.requestId 找出对应的在途流，标记中止并触发
          // router 的 cancel()（→ provider.stopStream best-effort）。回执发给 cancel 自己的 id。
          const requestId = (env.params as { requestId?: unknown } | undefined)?.requestId;
          if (typeof requestId === 'number') {
            const target = inflightStreams.get(requestId);
            if (target) { target.aborted = true; void target.cancel(); }
          }
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
    // port 存活追踪：reload 扩展 / popup 关闭 / SW 重启时 port 被 Chrome 关闭，
    // 后续 postMessage 会抛 "Attempting to use a disconnected port object"。
    // 所有发送走 safePostPanel（与 deepapi 分支 safePost 同范式）。
    let panelAlive = true;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      panelAlive = false;
      panelPorts.delete(port);
    });
    const safePostPanel = (m: unknown): void => {
      if (!panelAlive) return;
      try {
        port.postMessage(m as any);
      } catch {
        panelAlive = false;
      }
    };
    port.onMessage.addListener(async (msg: any) => {
      // 2026-09-11（fix/review-r1）：build() 移进 try；构建失败不得让 handler reject 后无任何回包。
      try {
      const { router, log } = await build();
      if (msg?.kind === 'panel.getState') {
        const provCfg = await getProviderConfig('deepseek');
        const logList = (await STORAGE.get('log')) as unknown as { log?: any[] };
        safePostPanel({
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
      } else if (msg?.kind === 'panel.resyncAuth') {
        // 重新同步（v0.1.63）：先 repush（重注 content script 同步 token），再探测登录状态。
        // 代替 v0.1.62 的两个独立按钮「重新探测」+ 「立即同步」——一次操作同时覆盖正常场景与 token 缓存过期场景。
        try {
          const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
          console.log('[deep.api sw] resyncAuth: found', tabs.length, 'chat.deepseek.com tab(s)');
          for (const t of tabs) {
            if (t.id !== undefined) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: t.id, allFrames: true },
                  files: ['bridge-main.js'],
                });
                console.log('[deep.api sw] resyncAuth: re-injected into tab', t.id, t.url);
              } catch (e) { console.warn('[deep.api sw] resyncAuth: failed for tab', t.id, e); }
            }
          }
        } catch (e) { console.warn('[deep.api sw] resyncAuth: repush error', e); }
        await refreshAuthAndLog();
        await broadcastPanelState();
      } else if (msg?.kind === 'panel.setPool') {
        // 2026-09-11（fix/review-r1）：夹取到 spec §8.2 的 1–5；面板清空输入框时 Number('')=0 会被
        // 当成合法值写进 storage——poolSize=0 会让 register() 的 LRU 淘汰把刚建的会话也删掉。
        // 另外实时应用到运行中的实例：旧实现只写 storage，已缓存的 mapper/queue 仍用旧值。
        const raw = Number(msg.payload?.poolSize);
        if (Number.isFinite(raw)) {
          const poolSize = Math.min(5, Math.max(1, Math.floor(raw)));
          await setProviderConfig('deepseek', { poolSize });
          router.setPoolSize(poolSize);
        }
      } else if (msg?.kind === 'panel.setTtl') {
        // 夹取到 1–1440 分钟；ttlMinutes=0 会让每轮请求前就清光所有 thread（每次都 rebuild）。
        const raw = Number(msg.payload?.ttlMinutes);
        if (Number.isFinite(raw)) {
          const ttlMinutes = Math.min(1440, Math.max(1, Math.floor(raw)));
          await setProviderConfig('deepseek', { ttlMinutes });
          router.setTtlMinutes(ttlMinutes);
        }
      } else if (msg?.kind === 'panel.listLogs') {
        safePostPanel({ kind: 'state', payload: { log: log.list() } });
      } else if (msg?.kind === 'panel.listThreads') {
        const { mapper } = await build();
        safePostPanel({ kind: 'state', payload: { threads: mapper.listThreads() } });
      } else if (msg?.kind === 'ping') {
        safePostPanel({ kind: 'pong' });
      }
      } catch (e) {
        console.warn('[deep.api sw] panel message failed:', msg?.kind, e);
        safePostPanel({ kind: 'error', payload: { message: e instanceof Error ? e.message : String(e) } });
      }
    });
  }
});

export {};
