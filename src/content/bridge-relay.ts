import { isBridgeRequest } from '../shared/protocol';

console.log('[deep.api bridge-relay] module loaded on', location.host, 'at', new Date().toISOString());

export interface RelayPort {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
}

/**
 * 安装 page ↔ SW 的转发桥（window message listener + 20s ping 保活）。
 * 2026-09-11（fix/review-r1 A3）：返回 dispose —— 重连前必须先清理旧 listener/interval，
 * 否则每次重连都净增一个常驻 window message listener 与一个 20s 定时器（随重连线性泄漏）。
 */
export function createRelay(target: Window, port: RelayPort): () => void {
  console.log('[deep.api bridge-relay] createRelay called');
  // 监听来自 page 的请求包 → 转发给 SW
  const onWindowMessage = (ev: MessageEvent): void => {
    if (ev.source !== null && ev.source !== target) return;
    if (!isBridgeRequest(ev.data)) return;
    try {
      port.postMessage(ev.data);
    } catch {
      // port died (SW 重载/禁用)；静默忽略，onDisconnect 会触发重连
    }
  };
  target.addEventListener('message', onWindowMessage);
  // SW 响应/事件 → 转发给 page
  port.onMessage((m) => { target.postMessage(m, '*'); });
  // 流活跃保活（ping 只维持 SW 存活；端口断开时 postMessage 抛错被吞）
  const pingTimer = setInterval(() => {
    try { port.postMessage({ __deepApi: { kind: 'ping' } }); }
    catch { /* port died, ignore */ }
  }, 20_000);
  return () => {
    target.removeEventListener('message', onWindowMessage);
    clearInterval(pingTimer);
  };
}

// 内容脚本入口：连 MV3 SW；SW 重载/失效时自动重连
// 2026-09-16（feat/relay-auto-recovery）：同世代唯一性守卫。扩展重载/更新后 SW 会向所有开着的
// http/https 标签页重注入本脚本（relay-recovery.ts）；同世代隔离 world 共享 window，
// 在位 relay 活着（isAlive=true）时新注入直接让位，避免双 relay 把每个页面请求转发两遍。
// 孤儿（上下文已销毁，chrome.runtime.id 缺失）isAlive 必为 false → 新 relay 无缝接管，
// 桥免刷新自动恢复；旧孤儿的 window listener 仍在但转发进死 port（被吞），无害。
declare global { interface Window { __deepApiRelay?: { isAlive(): boolean } } }
(function startRelay() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  let incumbentAlive = false;
  try { incumbentAlive = window.__deepApiRelay?.isAlive() === true; } catch { /* 注册表畸形：按无在位处理 */ }
  if (incumbentAlive) {
    console.log('[deep.api bridge-relay] live relay already owns this page, skip');
    return;
  }
  window.__deepApiRelay = {
    isAlive: () => { try { return !!chrome.runtime?.id; } catch { return false; } },
  };
  const RELAY_PORT_NAME = 'deepapi';
  const BASE_RETRY_MS = 1000;
  const MAX_RETRY_MS = 30_000;

  let currentPort: chrome.runtime.Port | null = null;
  let forwardToPage: ((m: unknown) => void) | null = null;
  let retryDelayMs = BASE_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposeRelay: (() => void) | null = null;

  /** 终态判定：上下文已被销毁（扩展重载/更新后的孤儿脚本），重试永远不可能成功。
   *  双判据：① chrome.runtime.id 在孤儿上下文返回 undefined（可靠信号；某些版本访问即抛，一并视为失效）；
   *  ② Chrome 报错文案 "Extension context invalidated"（错文案稳定，作为 id 判据的兑底）。 */
  function isContextInvalidated(e: unknown): boolean {
    try {
      if (!chrome.runtime?.id) return true;
    } catch { return true; }
    return e instanceof Error && e.message.includes('Extension context invalidated');
  }

  // 2026-09-11（fix/review-r1 A3）：稳定的 port 代理——relay（window listener + ping）只装一次，
  // 内部始终引用最新 currentPort；重连只换 port，不再新增 listener/interval。
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

  /** 尝试连接一次。失败不放弃：2026-09-11 前旧实现只有一次重连机会，失败即永久断桥。 */
  function open(): void {
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connect({ name: RELAY_PORT_NAME });
    } catch (e) {
      // 2026-09-15（fix/relay-orphan-stop）：扩展重载/更新后，已开页面里驻留的旧 content script
      // 上下文已被 Chrome 销毁，connect 永远抛 "Extension context invalidated"，旧上下文永不恢复。
      // 旧实现照常退避重试 → 每个老标签页永久刷错（用户实测 localhost:5173 页面 console 堆栈）。
      // 上下文失效属终态：停机，打一条可行动的提示（刷新页面重新注入新脚本）。
      if (isContextInvalidated(e)) {
        console.warn('[deep.api bridge-relay] extension context invalidated — refresh this page to restore the bridge (retry stopped)');
        return;
      }
      console.warn('[deep.api bridge-relay] connect failed, retrying', e);
      scheduleReconnect();
      return;
    }
    retryDelayMs = BASE_RETRY_MS;   // 连接成功：重置退避
    currentPort = p;
    // SW → page：把本 port 的消息挂到 relay 的转发回调（relay 本体只装一次）
    p.onMessage.addListener((m: unknown) => { forwardToPage?.(m); });
    p.onDisconnect.addListener(() => {
      if (currentPort !== p) return;
      currentPort = null;
      console.log('[deep.api bridge-relay] port disconnected, reconnecting');
      scheduleReconnect();
    });
    if (!disposeRelay) disposeRelay = createRelay(window, portProxy);
    console.log('[deep.api bridge-relay] port opened');
  }

  console.log('[deep.api bridge-relay] startRelay: opening initial port');
  open();
})();
