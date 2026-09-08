import { isBridgeRequest } from '../shared/protocol';

console.log('[deep.api bridge-relay] module loaded on', location.host, 'at', new Date().toISOString());

export interface RelayPort {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
}

export function createRelay(target: Window, port: RelayPort): void {
  console.log('[deep.api bridge-relay] createRelay called');
  // 监听来自 page 的请求包 → 转发给 SW
  target.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== null && ev.source !== target) return;
    if (!isBridgeRequest(ev.data)) return;
    try {
      port.postMessage(ev.data);
    } catch {
      // port died (SW 重载/禁用)；静默忽略，onDisconnect 会触发重连
    }
  });
  // SW 响应/事件 → 转发给 page
  port.onMessage((m) => { target.postMessage(m, '*'); });
  // 流活跃保活
  setInterval(() => {
    try { port.postMessage({ __deepApi: { kind: 'ping' } }); }
    catch { /* port died, ignore */ }
  }, 20_000);
}

// 内容脚本入口：连 MV3 SW；SW 重载/失效时自动重连
(function startRelay() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  let currentPort: chrome.runtime.Port | null = null;
  function open(): chrome.runtime.Port | null {
    try {
      const p = chrome.runtime.connect({ name: 'deepapi' });
      currentPort = p;
      p.onDisconnect.addListener(() => {
        console.log('[deep.api bridge-relay] port disconnected, reconnecting in 1s');
        if (currentPort === p) { currentPort = null; setTimeout(open, 1000); }
      });
      console.log('[deep.api bridge-relay] port opened');
      createRelay(window, {
        postMessage: (m) => { try { p.postMessage(m); } catch { /* ignore */ } },
        onMessage: (cb) => p.onMessage.addListener((m: unknown) => cb(m)),
      });
      return p;
    } catch { return null; }
  }
  console.log('[deep.api bridge-relay] startRelay: opening initial port');
  open();
})();
