// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bridgeMainFactory } from '../../src/content/bridge-main';
import type { BridgeResponseMsg } from '../../src/shared/protocol';
import type { ChatCompletionChunk } from '../../src/shared/api-types';

function fakeChromeApi(port: any) {
  (globalThis as any).chrome = {
    runtime: { connect: () => port, sendMessage: () => {} },
  };
}
function clearChromeApi() { delete (globalThis as any).chrome; }

function fakePort() {
  const sent: unknown[] = [];
  let cb: ((m: unknown) => void) | null = null;
  const disconnectListeners: Array<() => void> = [];
  const port = {
    sent,
    postMessage: (m: unknown) => { sent.push(m); },
    onMessage: { addListener: (f: (m: unknown) => void) => { cb = f; } },
    onDisconnect: { addListener: (f: () => void) => { disconnectListeners.push(f); } },
    _disconnect: () => { disconnectListeners.forEach(f => f()); },
    emit: (m: unknown) => { cb?.(m); },
  };
  return port;
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function findSent<T = any>(port: { sent: unknown[] }, method: string): T | undefined {
  return port.sent.find((m: any) => m?.__deepApi?.method === method) as T | undefined;
}

/** 模拟 SW 响应：直接 window.postMessage 到 page（bridge-main 的 target listener 会收到） */
function sendResponse(id: number, body: object) {
  window.postMessage({ __deepApi: { id, ...body } }, '*');
}

describe('bridge roundtrip', () => {
  let port: ReturnType<typeof fakePort>;
  beforeEach(() => {
    port = fakePort();
    fakeChromeApi(port);
  });
  afterEach(() => clearChromeApi());

  it('create() streams chunks; cancel() sends cancel', async () => {
    bridgeMainFactory(window as any);
    const api = (window as any).deepApi;
    const handle = api.chat.completions.create({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await flush();
    const req = findSent<{ __deepApi: { id: number; method: string } }>(port, 'chat.completions.create');
    expect(req).toBeDefined();
    const id = req!.__deepApi.id;
    const chunk: ChatCompletionChunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] };
    sendResponse(id, { kind: 'chunk', chunk });
    sendResponse(id, { kind: 'done' });
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of handle) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0].delta.content).toBe('你');
    await handle.cancel();
    await flush();
    const cancelReq = findSent<{ __deepApi: { method: string } }>(port, 'chat.completions.cancel');
    expect(cancelReq).toBeDefined();
  });

  it('rejects with BridgeError on error envelope', async () => {
    bridgeMainFactory(window as any);
    const api = (window as any).deepApi;
    const p = api.models.list();
    await flush();
    const req = findSent<{ __deepApi: { id: number } }>(port, 'models.list');
    expect(req).toBeDefined();
    const id = req!.__deepApi.id;
    sendResponse(id, { kind: 'error', error: { error: { message: 'rate limited', type: 'api_error', code: 'rate_limited' } } });
    await expect(p).rejects.toMatchObject({ status: 429 });
  });

  it('ignores foreign window messages', async () => {
    bridgeMainFactory(window as any);
    await flush();
    window.postMessage({ hello: 1 }, '*');
    window.postMessage({ __deepApi: { id: 999, method: 'evil', params: {} } }, '*');
    await flush();
    const createCalls = port.sent.filter((m: any) => m?.__deepApi?.method && m.__deepApi.method !== 'auth.sync');
    expect(createCalls).toHaveLength(0);
  });
});
