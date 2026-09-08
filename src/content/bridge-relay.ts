import { isBridgeRequest } from '../shared/protocol';

export interface RelayPort {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
}

export function createRelay(target: Window, port: RelayPort): void {
  target.addEventListener('message', (ev: MessageEvent) => {
    // ev.source 在 jsdom/同窗口 postMessage 下为 null；接受 null 与 === target 两种来源
    if (ev.source !== null && ev.source !== target) return;
    if (!isBridgeRequest(ev.data)) return;
    port.postMessage(ev.data);
  });
  port.onMessage((m) => { target.postMessage(m, '*'); });
  // 流活跃保活：每 20s 一次 ping；SW 侧 ping/pong 单独处理，不走 Router。
  setInterval(() => port.postMessage({ __deepApi: { kind: 'ping' } }), 20_000);
}

// 内容脚本入口：连 MV3 SW 并启动 relay
if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
  const port = chrome.runtime.connect({ name: 'deepapi' });
  createRelay(window, {
    postMessage: (m) => port.postMessage(m),
    onMessage: (cb) => port.onMessage.addListener((m: unknown) => cb(m)),
  });
}
