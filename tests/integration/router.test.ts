import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { Message } from '../../src/shared/api-types';

const MODELS = [
  { id: 'deepseek-v4-flash', provider: 'deepseek', description: 'v4-flash' },
  { id: 'deepseek-v4-pro', provider: 'deepseek', description: 'v4-pro' },
  { id: 'deepseek-v4-flash-vision-exp', provider: 'deepseek', description: 'v4-vision' },
];

type StubExtras = Partial<ProviderAdapter> & { prompts?: string[] };

function stubAdapter(over: StubExtras = {}): ProviderAdapter {
  const prompts: string[] = [];
  let seq = 0;
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', cookieDomain: 'chat.deepseek.com', requiredCookies: ['user_token'], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: `s${++seq}`, parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (_ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
      prompts.push(req.prompt);
      yield { kind: 'message_id', id: 1 };
      yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
    },
    models: MODELS,
    resolveModel: (id: string) => id === 'deepseek-v4-flash'
      ? { modelId: id, modelType: 'default' as const, thinking: false, limitChars: 2_621_440 }
      : id === 'deepseek-v4-pro'
        ? { modelId: id, modelType: 'expert' as const, thinking: true, limitChars: 163_840 }
        : id === 'deepseek-v4-flash-vision-exp'
          ? { modelId: id, modelType: 'vision' as const, thinking: false, limitChars: 2_621_440 }
          : null,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    ...over,
  };
  return Object.assign(base, { prompts });
}

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

function makeRouter(adapter: ProviderAdapter) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 2, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 60_000, now }),
    storage: { get: async () => undefined, set: async () => undefined },
    log: new RingLog(20),
    now,
  });
  return router;
}

const TOKEN = 'tok-from-cookie';

describe('Router', () => {
  it('aggregates non-stream and streams chunks', async () => {
    const a = stubAdapter(); const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(res.choices[0].message.content).toBe('ok');
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')], stream: true });
    const chunks: any[] = [];
    for await (const c of (s as any)) chunks.push(c);
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop');
  });

  it('returns models list wrapper', async () => {
    const r = makeRouter(stubAdapter());
    const list: any = await r.models();
    expect(list.object).toBe('list');
    expect(list.data.map((m: any) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);
  });

  it('unknown model → 400', async () => {
    const r = makeRouter(stubAdapter());
    await expect(r.create(TOKEN, { model: 'gpt-4o', messages: [m('user', 'hi')] })).rejects.toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
  });

  it('incremental second call sends only tail', async () => {
    const a = stubAdapter(); const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi'), m('user', 'next')] });
    expect((a as any).prompts).toHaveLength(2);
    expect((a as any).prompts[0]).toContain('hi');
    expect((a as any).prompts[1]).toContain('next');
  });

  it('named conversation_id first call uses the provided cid (not auto:seq) — v0.1.38 fix', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '记住数字 42')], conversation_id: 'demo-x' });
    // 第二次用同 cid → 应 incremental（复用 s1），不是新建 s2
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '记住数字 42'), m('user', '刚才那个数字是什么？')], conversation_id: 'demo-x' });
    // 验证：只有一次 createSession（第二次命中 incremental 复用 s1）
    // streamCompletion 被调两次但都走同一 webSessionId='s1'
    expect((a as any).prompts).toHaveLength(2);
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
      const r = makeRouter(a);
      const p = r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
      await vi.advanceTimersByTimeAsync(1500);
      const res: any = await p;
      expect(calls).toBe(3);
      expect(res.choices[0].message.content).toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('over-limit transcript → 400 invalid_request_error', async () => {
    const r = makeRouter(stubAdapter());
    await expect(r.create(TOKEN, { model: 'deepseek-v4-pro', messages: [m('user', 'x'.repeat(163_841))] })).rejects.toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
  });

  it('provider_unavailable when blocked (WAF) → 503', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () { throw { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }; },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] })).rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
  });

  it('auth-expired → 503 with re-login message', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () { throw { status: 401 }; },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] })).rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
  });
});

// 2026-09-09（feat/diagnostic-logging）：popup 日志区需要的诊断现场。
// spice 报“每发一条消息重建一条”需看 threadFound / mirrorPrefixOk / deletedOld / action 判断“多次调中有无轮番 rebuild 删 old”。
describe('Router 诊断日志（v0.1.50）', () => {
  it('首调无 cid → rebuild、threadFound=false、deletedOld=false、msgsLen 带 N', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'a'), m('user', 'b')] });
    const list = r['d'].log.list();
    const last = list[list.length - 1]!;
    expect(last.action).toBe('rebuild');
    expect(last.threadFound).toBe(false);
    expect(last.deletedOld).toBe(false);
    expect(last.msgsLen).toBe(2);
    expect(last.mirrorLen).toBeUndefined();
    expect(last.ok).toBe(true);
    expect(last.finishReason).toBe('stop');
    expect(last.cid).toMatch(/^auto:\d+$/);
  });

  it('传同 cid 第二次调 → incremental、threadFound=true、mirrorPrefixOk=true、msgsLen 递增', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'a'), m('user', 'b')], conversation_id: 'spice-cid' });
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'a'), m('user', 'b'), m('assistant', 'ok'), m('user', 'c')], conversation_id: 'spice-cid' });   // stub streamCompletion 返回 content='ok'，所以镜像里 assistant.content='ok'
    const list = r['d'].log.list();
    expect(list).toHaveLength(2);
    const e0 = list[0]!;
    const e1 = list[1]!;
    expect(e0.action).toBe('rebuild');
    expect(e0.threadFound).toBe(false);
    expect(e0.deletedOld).toBe(false);
    expect(e0.cid).toBe('spice-cid');
    expect(e1.action).toBe('incremental');
    expect(e1.threadFound).toBe(true);
    expect(e1.mirrorPrefixOk).toBe(true);
    expect(e1.deletedOld).toBe(false);
    expect(e1.mirrorLen).toBe(3);   // call 1 commit 后 mirror = [user:a, user:b, assistant:r1] = 3
    expect(e1.msgsLen).toBe(4);
  });

  it('同 cid 但 mirror 不匹配（修改了中间一条）→ rebuild 且 deletedOld=true', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'a'), m('user', 'b')], conversation_id: 'spice-cid' });
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'a-CHANGED'), m('user', 'b')], conversation_id: 'spice-cid' });   // stub 返回 'ok'，call 1 镜像含 assistant:'ok'，但这次没带 — mirror 不匹配
    const list = r['d'].log.list();
    const e1 = list[1]!;
    expect(e1.action).toBe('rebuild');
    expect(e1.threadFound).toBe(true);
    expect(e1.mirrorPrefixOk).toBe(false);
    expect(e1.deletedOld).toBe(true);
    expect(e1.mirrorLen).toBe(3);   // call 1 commit 后 mirror = 3 条
  });
});
