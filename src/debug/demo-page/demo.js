// Shim: 在 chrome-extension:// 页面下，content script 不会注入 window.deepApi。
// 外部网页（chat.deepseek.com / example.com 等）由 bridge-main 注入。
// chrome-extension:// 页面加载时没有深链，所以自己用 chrome.runtime.connect('deepapi')
// 直连 SW（SW 在 sw.ts:211 'deepapi' 端口处理 chat.completions.create / models.list / auth.requested），
// 模拟 window.deepApi。Chat / Scenarios tab 直接调 window.deepApi.chat.completions.create 即可。
if (!window.deepApi && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
  const pending = new Map();
  let seq = 0;
  const sseChunkFrame = (c) => 'data: ' + JSON.stringify(c) + '\n\n';
  const sseErrorFrame = (err) => 'data: ' + JSON.stringify({ error: err.error || { message: 'unknown', code: 'internal_error' } }) + '\n\n';

  // 2026-09-11（fix/review-r1）：port 断线恢复。旧实现只在加载时 connect 一次、没有 onDisconnect
  // 也没有保活——扩展 reload / SW 回收后 port 死掉，之后每次调用都失败且页面里没有任何重连入口。
  // 现在：断线时结算所有在飞请求（非流式 reject、流式推 error+[DONE]，避免调用方永久挂起），
  // 下一次 send 或 20s 保活 ping 会自动重连。
  let port = null;
  let dead = false;

  function failPending(err) {
    for (const [, p] of pending) {
      p.settled = true;
      if (p.isStream) {
        p.queue.push(sseErrorFrame({ error: { message: err.message, code: 'provider_unavailable' } }));
        p.queue.push('data: [DONE]\n\n');
        const w = p._wake; p._wake = null; if (w) w();
      } else {
        try { p._reject && p._reject(err); } catch (e) { /* 已满足的 promise，忽略 */ }
      }
    }
    pending.clear();
  }

  function openPort() {
    port = chrome.runtime.connect({ name: 'deepapi' });
    dead = false;
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      dead = true;
      failPending(new Error('deepapi port disconnected（扩展可能已重载，稍后重试）'));
    });
  }

  function ensurePort() {
    if (dead || !port) openPort();
    return port;
  }

  const onMessage = (env) => {
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
  };

  openPort();
  // 保活：流活跃期间维持 SW（20s ping，与 bridge-relay 同范式）。
  // 测试环境（node vm）可能没提供 setInterval → 跳过，避免 ReferenceError。
  if (typeof setInterval === 'function') {
    const keepalive = setInterval(() => {
      try { ensurePort().postMessage({ __deepApi: { kind: 'ping' } }); }
      catch (e) { dead = true; }
    }, 20_000);
    if (keepalive && typeof keepalive.unref === 'function') keepalive.unref();
  }

  const send = (params) => {
    const id = ++seq;
    const isStream = !!params.stream;
    const p = { isStream, queue: [], settled: false };
    pending.set(id, p);
    ensurePort().postMessage({ __deepApi: { id, method: 'chat.completions.create', params } });
    if (isStream) {
      // OpenAI SDK 期望 Response-like 对象：body 是 ReadableStream<Uint8Array>。
      // 每个 chunk 含一个或多个 SSE 帧（'data: {...}\n\n' 或 'data: [DONE]\n\n'）。
      // Tab 代码（chat.ts / scenarios.ts stream 分支）用 res.body.getReader() + TextDecoder 按 \n\n 切帧。
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            // 等数据或关闭
            while (p.queue.length === 0 && !p.settled) {
              await new Promise((r) => { p._wake = r; });
            }
            // drain 队列（按帧保持，不要把多帧拼一起 enqueue，避免 tab 切帧时跨 chunk 边界问题）
            while (p.queue.length > 0) {
              controller.enqueue(enc.encode(p.queue.shift()));
            }
            if (p.settled) controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  const sendSimple = (method, params) => {
    const id = ++seq;
    const p = { isStream: false, queue: [], settled: false };
    pending.set(id, p);
    ensurePort().postMessage({ __deepApi: { id, method, params } });
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  window.deepApi = {
    models: { list: () => sendSimple('models.list', {}) },
    chat: { completions: { create: send } },
  };
}

import { mountDebugPanel } from '../debug-panel';
mountDebugPanel(document.getElementById('root'));
