// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { bridgeMainFactory } from '../../src/content/bridge-main';
import { createRelay } from '../../src/content/bridge-relay';
import type { BridgeResponseMsg } from '../../src/shared/protocol';
import type { ChatCompletionChunk } from '../../src/shared/api-types';

function fakePort() {
  const sent: unknown[] = [];
  let cb: ((m: unknown) => void) | null = null;
  return {
    sent,
    postMessage: (m: unknown) => { sent.push(m); },
    onMessage: (f: (m: unknown) => void) => { cb = f; },
    emit: (m: unknown) => { cb?.(m); },
  };
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('bridge roundtrip', () => {
  it('create() streams chunks; cancel() sends cancel', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    bridgeMainFactory(window as any);
    const api = (window as any).deepApi;
    const handle = api.chat.completions.create({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await flush();
    const req = port.sent[0] as { __deepApi: { id: number; method: string } };
    expect(req.__deepApi.method).toBe('chat.completions.create');
    const id = req.__deepApi.id;
    const chunk: ChatCompletionChunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] };
    port.emit({ __deepApi: { id, kind: 'chunk', chunk } } satisfies BridgeResponseMsg);
    port.emit({ __deepApi: { id, kind: 'done' } } satisfies BridgeResponseMsg);
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of handle) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0].delta.content).toBe('你');
    await handle.cancel();
    await flush();
    const cancelReq = port.sent[1] as { __deepApi: { method: string } };
    expect(cancelReq.__deepApi.method).toBe('chat.completions.cancel');
  });

  it('rejects with BridgeError on error envelope', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    bridgeMainFactory(window as any);
    const api = (window as any).deepApi;
    const p = api.models.list();
    await flush();
    const id = (port.sent[0] as any).__deepApi.id;
    port.emit({ __deepApi: { id, kind: 'error', error: { error: { message: 'bad key', type: 'api_error', code: 'invalid_api_key' } } } } satisfies BridgeResponseMsg);
    await expect(p).rejects.toMatchObject({ status: 401 });
  });

  it('ignores foreign window messages', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    window.postMessage({ hello: 1 }, '*');
    window.postMessage({ __deepApi: { id: 999, method: 'evil', params: {} } }, '*');
    await flush();
    expect(port.sent).toHaveLength(0);
  });
});
