import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { Message } from '../../src/shared/api-types';

const MODELS = [
  { id: 'deepseek-chat', provider: 'deepseek', description: 'v3' },
  { id: 'deepseek-reasoner', provider: 'deepseek', description: 'r1' },
];

type StubExtras = Partial<ProviderAdapter> & { prompts?: string[] };

function stubAdapter(over: StubExtras = {}): ProviderAdapter {
  const prompts: string[] = [];
  const resolved = (id: string) => id === 'deepseek-chat'
    ? { modelId: id, modelType: 'default' as const, thinking: false, limitChars: 2_621_440 }
    : id === 'deepseek-reasoner'
      ? { modelId: id, modelType: 'expert' as const, thinking: true, limitChars: 163_840 }
      : null;
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', cookieDomain: 'chat.deepseek.com', requiredCookies: ['user_token'], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: 's1', parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (_ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
      prompts.push(req.prompt);
      yield { kind: 'message_id', id: 1 };
      yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
    },
    models: MODELS,
    resolveModel,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    ...over,
  };
  return Object.assign(base, { prompts });
}
function resolveModel(id: string) {
  if (id === 'deepseek-chat') return { modelId: id, modelType: 'default' as const, thinking: false, limitChars: 2_621_440 };
  if (id === 'deepseek-reasoner') return { modelId: id, modelType: 'expert' as const, thinking: true, limitChars: 163_840 };
  return null;
}

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

function makeRouter(adapter: ProviderAdapter, storage: Record<string, unknown> = {}) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 2, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 60_000, now }),
    storage: { get: async (k: string) => storage[k], set: async (k: string, v: unknown) => { storage[k] = v; } },
    log: new RingLog(20),
    now,
    ensureKey: async () => 'sk-dapi-1234',
  });
  return router;
}

const KEY = { apiKey: 'sk-dapi-1234' };

describe('Router', () => {
  it('rejects missing api key', async () => {
    const r = makeRouter(stubAdapter());
    await expect(r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')] })).rejects.toMatchObject({ status: 401, error: { error: { code: 'missing_api_key' } } });
  });

  it('aggregates non-stream and streams chunks', async () => {
    const a = stubAdapter(); const r = makeRouter(a, { apiKey: 'sk-dapi-1234' });
    const res: any = await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
    expect(res.choices[0].message.content).toBe('ok');
    const s = await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], stream: true, ...KEY });
    const chunks: any[] = [];
    for await (const c of (s as any)) chunks.push(c);
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop');
  });

  it('returns models list wrapper', async () => {
    const r = makeRouter(stubAdapter(), { apiKey: 'sk-dapi-1234' });
    const list: any = await r.models();
    expect(list.object).toBe('list');
    expect(list.data.map((m: any) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('unknown model → 400', async () => {
    const r = makeRouter(stubAdapter(), { apiKey: 'sk-dapi-1234' });
    await expect(r.create({ model: 'gpt-4o', messages: [m('user', 'hi')], ...KEY })).rejects.toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
  });

  it('incremental second call sends only tail', async () => {
    const a = stubAdapter(); const r = makeRouter(a, { apiKey: 'sk-dapi-1234' });
    await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
    await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi'), m('user', 'next')], ...KEY });
    expect((a as any).prompts).toHaveLength(2);
    expect((a as any).prompts[0]).toContain('hi');
    expect((a as any).prompts[1]).toContain('next');
  });

  it('rate-limited twice then succeeds with backoff', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          if (calls <= 2) throw { status: 429 };
          yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
        },
      });
      const r = makeRouter(a, { apiKey: 'sk-dapi-1234' });
      const p = r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
      await vi.advanceTimersByTimeAsync(1500); // 500 + 1000
      const res: any = await p;
      expect(calls).toBe(3);
      expect(res.choices[0].message.content).toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('over-limit transcript → 400 invalid_request_error', async () => {
    const r = makeRouter(stubAdapter(), { apiKey: 'sk-dapi-1234' });
    await expect(r.create({ model: 'deepseek-reasoner', messages: [m('user', 'x'.repeat(163_841))], ...KEY })).rejects.toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
  });

  it('provider_unavailable when blocked (WAF) → 503', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () { throw { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }; },
    });
    const r = makeRouter(a, { apiKey: 'sk-dapi-1234' });
    await expect(r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY })).rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
  });

  it('auth-expired → 503 with re-login message', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () { throw { status: 401 }; },
    });
    const r = makeRouter(a, { apiKey: 'sk-dapi-1234' });
    await expect(r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY })).rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
  });
});
