/**
 * ChatGPT 页面 ISOLATED world ↔ SW 转发桥。
 *
 * 与 deepseek 版（src/content/bridge-relay.ts）平行存在：
 *   - deepseek 用 `__deepApi` 协议（router / bridge-main.ts）
 *   - chatgpt 用 `__deepApiChatGPT` 协议（chatgpt-bridge-main.ts）
 *
 * 两条独立协议 + 两条独立 relay：共用一个 port name 会让 SW 端 onConnect 处理两个不同
 * 协议的消息时很混乱（要逐消息判 kind）。本文件维持「独立协议 + 独立 port name + 独立 relay」三件套。
 *
 * 关键约束（来自 brief 与 Task 3 实现者自报）：
 *   - 页面上的任何脚本都能 postMessage，必须用 `__deepApiChatGPT === true` 过滤**外来**消息。
 *   - 扩展重载/更新后旧 content script 上下文已销毁（"Extension context invalidated"），属终态：
 *     旧实现会无限重试，刷屏；本模块照 deepseek 版做法：终态停机 + 提示刷新页面。
 *   - listener / interval 不随重连线性泄漏（只用一次 createRelay + 稳定 port 代理）。
 *
 * port name 用 'deepapi-chatgpt'（与 deepseek 的 'deepapi' / panel 的 'deepapi-panel' 并列），
 * SW 的 onConnect 据此分流到 chatgpt bridge-client。
 */

console.log('[deep.api chatgpt-bridge-relay] module loaded on', location.host, 'at', new Date().toISOString());

export interface RelayPort {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
}

/**
 * 只接受「来自 self window 的 chatgpt 桥消息」并转发到 port；其它一律不转发。
 * relay 安装一次；dispose 时清掉 listener + ping interval（避免重连线性泄漏）。
 */
export function createRelay(target: Window, port: RelayPort): () => void {
  console.log('[deep.api chatgpt-bridge-relay] createRelay called');
  // 监听来自 page 的请求包 → 转发给 SW
  const onWindowMessage = (ev: MessageEvent): void => {
    // 防 cross-origin 噪音：仅当 source 是 self window 时接收
    if (ev.source !== null && ev.source !== target) return;
    // ① 必须是 chatgpt 桥消息（__deepApiChatGPT === true）；② shape 合法
    if (typeof ev.data !== 'object' || ev.data === null) return;
    const m = ev.data as { __deepApiChatGPT?: unknown; kind?: unknown };
    if (m.__deepApiChatGPT !== true) return;     // 关键过滤：其它页脚本 postMessage 一律丢弃
    try {
      port.postMessage(ev.data);
    } catch {
      // port died (SW 重载/禁用)；静默忽略，onDisconnect 会触发重连
    }
  };
  target.addEventListener('message', onWindowMessage);
  // SW 响应/事件 → 转发给 page（来自 SW 的消息都是合法的 __deepApiChatGPT 消息——SW 侧自己路由）
  port.onMessage((m) => { target.postMessage(m, '*'); });
  // 流活跃保活（ping 只维持 SW 存活；端口断开时 postMessage 抛错被吞）
  const pingTimer = setInterval(() => {
    try { port.postMessage({ __deepApiChatGPT: true, kind: 'ping' }); }
    catch { /* port died, ignore */ }
  }, 20_000);
  return () => {
    target.removeEventListener('message', onWindowMessage);
    clearInterval(pingTimer);
  };
}

// 内容脚本入口：连 MV3 SW；SW 重载/失效时自动重连
// 2026-09-16（feat/relay-auto-recovery）平行范式：同 chatgpt.com 标签页只能有一个 relay。
// 注册表用 `__deepApiChatGPTRelay`（与 deepseek 的 `__deepApiRelay` 区分）。
declare global { interface Window { __deepApiChatGPTRelay?: { isAlive(): boolean } } }
(function startRelay() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  let incumbentAlive = false;
  try { incumbentAlive = window.__deepApiChatGPTRelay?.isAlive() === true; } catch { /* 注册表畸形：按无在位处理 */ }
  if (incumbentAlive) {
    console.log('[deep.api chatgpt-bridge-relay] live relay already owns this page, skip');
    return;
  }
  window.__deepApiChatGPTRelay = {
    isAlive: () => { try { return !!chrome.runtime?.id; } catch { return false; } },
  };
  const RELAY_PORT_NAME = 'deepapi-chatgpt';
  const BASE_RETRY_MS = 1000;
  const MAX_RETRY_MS = 30_000;

  let currentPort: chrome.runtime.Port | null = null;
  let forwardToPage: ((m: unknown) => void) | null = null;
  let retryDelayMs = BASE_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeRelay: (() => void) | null = null;

  /** 终态判定：上下文已被销毁（扩展重载/更新后的孤儿脚本），重试永远不可能成功。 */
  function isContextInvalidated(e: unknown): boolean {
    try {
      if (!chrome.runtime?.id) return true;
    } catch { return true; }
    return e instanceof Error && e.message.includes('Extension context invalidated');
  }

  // 稳定的 port 代理——relay（window listener + ping）只装一次，内部始终引用最新 currentPort
  const portProxy: RelayPort = {
    postMessage: (m) => {
      try { currentPort?.postMessage(m); } catch { /* port died, ignore */ }
    },
    onMessage: (cb) => { forwardToPage = cb; },
  };

  function scheduleReconnect(): void {
    if (retryTimer !== null) return;   // 单飞：已有一次待执行的重连
    const delay = retryDelayMs;
    // 指数退避，上限 30s（成功连接后重置，见 open）
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connect({ name: RELAY_PORT_NAME });
    } catch (e) {
      // 上下文失效属终态：停机，打一条可行动的提示（刷新页面重新注入新脚本）。
      // 2026-10-05（chore/chatgpt-relay-info）：与 bridge-relay.ts 对齐降为 info——扩展刚重载过
      // 后的预期路径（relay-recovery 会自动重注入新 relay 接管），不是故障；warn 会被宿主页面的
      // 错误收集器（如 Paseo IDE 的 Errors 面板）收走刷成噪音。非终态失败仍是 warn。
      if (isContextInvalidated(e)) {
        console.info('[deep.api chatgpt-bridge-relay] extension context invalidated — refresh this page to restore the bridge (retry stopped)');
        return;
      }
      console.warn('[deep.api chatgpt-bridge-relay] connect failed, retrying', e);
      scheduleReconnect();
      return;
    }
    retryDelayMs = BASE_RETRY_MS;
    currentPort = p;
    // SW → page：把本 port 的消息挂到 relay 的转发回调（relay 本体只装一次）
    p.onMessage.addListener((m: unknown) => { forwardToPage?.(m); });
    p.onDisconnect.addListener(() => {
      if (currentPort !== p) return;
      currentPort = null;
      console.log('[deep.api chatgpt-bridge-relay] port disconnected, reconnecting');
      scheduleReconnect();
    });
    if (!disposeRelay) disposeRelay = createRelay(window, portProxy);
    console.log('[deep.api chatgpt-bridge-relay] port opened');
  }

  console.log('[deep.api chatgpt-bridge-relay] startRelay: opening initial port');
  open();
})();