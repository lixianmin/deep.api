import { describe, it, expect, beforeEach } from 'vitest';
import { sseChunkFrame, sseErrorFrame, sseDoneFrame } from '../../src/content/bridge-main';
import type { ChatCompletionChunk } from '../../src/shared/api-types';

// bridge-main.ts runs side-effects on import (registers window.deepApi + listeners).
// 我们的契约是 OpenAI Chat Completions SSE：stream:true 必须返回 Response-like（body.getReader），
// 让下游用标准 SSE 解析器读 data: {json}\n\n 帧。
// v0.1.49 之前 bridge-main 返回 AsyncIterable<string>，spice parseDeepApiSse 无法读 → 「AI 无回复」。
import '../../src/content/bridge-main';

describe('bridge-main SSE frame helpers (v0.1.45)', () => {
  it('sseChunkFrame wraps a chunk as "data: {json}\\n\\n"', () => {
    const c: ChatCompletionChunk = {
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }],
    };
    const f = sseChunkFrame(c);
    expect(f).toBe('data: ' + JSON.stringify(c) + '\n\n');
  });

  it('sseDoneFrame is exactly "data: [DONE]\\n\\n"', () => {
    expect(sseDoneFrame()).toBe('data: [DONE]\n\n');
  });

  it('sseErrorFrame wraps the error body so consumer can detect failure', () => {
    const f = sseErrorFrame({ error: { message: '网络中断', code: 'provider_unavailable' } });
    expect(f).toBe('data: ' + JSON.stringify({ error: { message: '网络中断', code: 'provider_unavailable' } }) + '\n\n');
  });

  it('sseErrorFrame falls back to unknown error when body is missing', () => {
    const f = sseErrorFrame({});
    const parsed = JSON.parse(f.replace(/^data: /, '').trim());
    expect(parsed.error.message).toBe('unknown');
    expect(parsed.error.code).toBe('internal_error');
  });

  it('OpenAI SSE 契约：所有帧以 \\n\\n 结尾，data: 行是单个 JSON 对象或 [DONE] 哨兵', () => {
    const c: ChatCompletionChunk = {
      id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm',
      choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }],
    };
    const frames = [sseChunkFrame(c), sseErrorFrame({ error: { message: 'x', code: 'y' } }), sseDoneFrame()];
    for (const f of frames) {
      expect(f.endsWith('\n\n')).toBe(true);
      expect(f.startsWith('data: ')).toBe(true);
      const data = f.slice(6, -2);  // 去 'data: ' 前缀和 '\n\n' 后缀
      // [DONE] 是 OpenAI 哨兵（不是 JSON）；其他帧必须是单个 JSON 对象
      if (data === '[DONE]') continue;
      expect(() => JSON.parse(data)).not.toThrow();
    }
  });
});

describe('bridge-main streamHandle Response shape (v0.1.49) — OpenAI SSE 契约', () => {
  let capturedRequestId: number | null;
  let origPostMessage: typeof window.postMessage;

  beforeEach(() => {
    capturedRequestId = null;
    origPostMessage = window.postMessage.bind(window);
    // 拦截 create() 内部的 postMessage：抓 request id，但不要真发出去（jsdom 没桥对端）
    window.postMessage = ((msg: unknown, _targetOrigin?: string) => {
      if (typeof msg === 'object' && msg !== null) {
        const env = (msg as { __deepApi?: { method?: string; id?: number } }).__deepApi;
        if (env && env.method === 'chat.completions.create' && typeof env.id === 'number') {
          capturedRequestId = env.id;
        }
      }
    }) as typeof window.postMessage;
  });

  function fireResponseEvent(data: unknown) {
    // bridge-main 的 message listener 判定 ev.source === null || === window
    const ev = new MessageEvent('message', { data, source: window });
    window.dispatchEvent(ev);
  }

  function readAllFrames(res: Response): Promise<string> {
    return (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder('utf-8');
      let acc = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
      }
      return acc;
    })();
  }

  it('stream:true 返回值是 Response-like（含 body.getReader）—— spec §3 Shape B', () => {
    const stream = (window as unknown as { deepApi: { chat: { completions: { create: (p: unknown) => unknown } } } }).deepApi.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(capturedRequestId).not.toBeNull();
    // 契约：下游必须能用 res.body.getReader() 读 SSE 帧
    const res = stream as Response;
    expect(typeof res.body?.getReader).toBe('function');
  });

  it('body 流出的帧形如 data: {json}\\n\\n + data: [DONE]\\n\\n', async () => {
    const stream = (window as unknown as { deepApi: { chat: { completions: { create: (p: unknown) => unknown } } } }).deepApi.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }) as Response;
    const id = capturedRequestId!;

    // 模拟 SW 推流：先一个 content chunk，再 done
    const chunk: ChatCompletionChunk = {
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
    };
    fireResponseEvent({ __deepApi: { id, kind: 'chunk', chunk } });
    fireResponseEvent({ __deepApi: { id, kind: 'done' } });

    const body = await readAllFrames(stream);
    expect(body).toMatch(/^data: \{/);                       // 第一帧是 data: {json}\n\n
    expect(body).toContain('"content":"你好"');             // 内容包含正确 delta
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);   // 终末帧 [DONE]
  });

  it('流式错误：onError 推 SSE error 帧 + [DONE]，consumer 不 hang', async () => {
    const stream = (window as unknown as { deepApi: { chat: { completions: { create: (p: unknown) => unknown } } } }).deepApi.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }) as Response;
    const id = capturedRequestId!;

    fireResponseEvent({ __deepApi: { id, kind: 'error', error: { error: { message: '网络中断', type: 'api_error', code: 'provider_unavailable' } } } });

    const body = await readAllFrames(stream);
    expect(body).toContain('"message":"网络中断"');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('取消：调用 Response.body.cancel() 触发 cancel() + 推 [DONE]，consumer 不 hang', async () => {
    const stream = (window as unknown as { deepApi: { chat: { completions: { create: (p: unknown) => unknown } } } }).deepApi.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }) as Response;
    const id = capturedRequestId!;

    // 立刻取消（无任何 chunk）
    await stream.body!.cancel();

    // 取消后该 stream 已 close，再 read 立即 done（不应 hang）
    const reader = stream.body!.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});
