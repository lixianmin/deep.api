// Shim: 在 chrome-extension:// 页面下，content script 不会注入 window.deepApi。
// 外部网页（chat.deepseek.com / example.com 等）由 bridge-main 注入。
// chrome-extension:// 页面加载时没有深链，所以自己用 chrome.runtime.connect('deepapi')
// 直连 SW（SW 在 sw.ts:211 'deepapi' 端口处理 chat.completions.create / models.list / auth.requested），
// 模拟 window.deepApi。Chat / Scenarios tab 直接调 window.deepApi.chat.completions.create 即可。
if (!window.deepApi && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
  const pending = new Map();
  const port = chrome.runtime.connect({ name: 'deepapi' });
  let seq = 0;
  const sseChunkFrame = (c) => 'data: ' + JSON.stringify(c) + '\n\n';
  const sseErrorFrame = (err) => 'data: ' + JSON.stringify({ error: err.error || { message: 'unknown', code: 'internal_error' } }) + '\n\n';

  port.onMessage.addListener((env) => {
    if (!env || !env.__deepApi) return;
    const e = env.__deepApi;
    const p = pending.get(e.id);
    if (!p) return;
    if (e.kind === 'chunk') {
      if (p.isStream) {
        p.queue.push(sseChunkFrame(e.chunk));
        const w = p._wake; if (w) { p._wake = null; w(); }
      }
    } else if (e.kind === 'result') {
      pending.delete(e.id);
      if (!p.isStream) {
        p.settled = true;
        const w = p._wake; if (w) { p._wake = null; w(); }
        p._resolve && p._resolve(e.value);
      }
    } else if (e.kind === 'done') {
      pending.delete(e.id);
      p.settled = true;
      const w = p._wake; if (w) { p._wake = null; w(); }
      if (p.isStream) {
        p.queue.push('data: [DONE]\n\n');
        if (p._wake) { p._wake = null; p._wake(); }
      }
    } else if (e.kind === 'error') {
      pending.delete(e.id);
      p.settled = true;
      const w = p._wake; if (w) { p._wake = null; w(); }
      if (p.isStream) {
        p.queue.push(sseErrorFrame(e.error));
        p.queue.push('data: [DONE]\n\n');
        if (p._wake) { p._wake = null; p._wake(); }
      } else {
        p._reject && p._reject(new Error((e.error && e.error.error && e.error.error.message) || 'bridge error'));
      }
    }
  });

  const send = (params) => {
    const id = ++seq;
    const isStream = !!params.stream;
    const p = { isStream, queue: [], settled: false };
    pending.set(id, p);
    port.postMessage({ __deepApi: { id, method: 'chat.completions.create', params } });
    if (isStream) {
      return (async function* () {
        while (true) {
          if (p.queue.length) { yield p.queue.shift(); continue; }
          if (p.settled) return;
          await new Promise((r) => { p._wake = r; });
        }
      })();
    }
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  const sendSimple = (method, params) => {
    const id = ++seq;
    const p = { isStream: false, queue: [], settled: false };
    pending.set(id, p);
    port.postMessage({ __deepApi: { id, method, params } });
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  window.deepApi = {
    models: { list: () => sendSimple('models.list', {}) },
    chat: { completions: { create: send } },
  };
}

import { mountDebugPanel } from '../debug-panel';
mountDebugPanel(document.getElementById('root'));
