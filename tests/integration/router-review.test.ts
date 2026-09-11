// 2026-09-11（fix/review-r1）：全量代码审查发现的路由层缺陷回归用例。
// 每个用例都先在当前实现上验证为失败（红），再由对应修复转绿。
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { ChatCompletion, Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

function stubAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  let seq = 0;
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', cookieDomain: 'chat.deepseek.com', requiredCookies: ['user_token'], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: `s${++seq}`, parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { kind: 'message_id', id: 1 };
      yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
    },
    models: [{ id: 'deepseek-flash', provider: 'deepseek', description: 'flash' }],
    resolveModel: (id: string) => id === 'deepseek-flash'
      ? { modelId: id, modelType: 'default' as const, supportsImages: false, thinking: false, limitChars: 2_621_440 }
      : null,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    ...over,
  };
  return base;
}

function setup(adapter: ProviderAdapter, storageGet: (k: string) => Promise<unknown | undefined> = async () => undefined) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 5, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 5_000, now }),
    storage: { get: storageGet },
    log: new RingLog(50),
    now,
    version: '0.0.0-test',
  });
  return { router, mapper };
}

const TOKEN = 'tok';
const REQ = { model: 'deepseek-flash', messages: [m('user', 'q')] };

describe('Router review-r1: usage 不得编造/重复', () => {
  it('流式：input 计数不可得（0）时省略 usage，不发 prompt_tokens:0 的编造分块', async () => {
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        yield { kind: 'content_delta', content: 'hi' };
        yield { kind: 'usage', inputTokens: 0, outputTokens: 5 };
      },
    });
    const { router } = setup(adapter);
    const resp = await router.create(TOKEN, { ...REQ, stream: true });
    const chunks: any[] = [];
    for await (const c of resp as AsyncIterable<any>) chunks.push(c);
    expect(chunks.filter(c => c.usage)).toEqual([]);
  });

  it('流式：input/output 都可得时 usage 只出现一次（终止分块）', async () => {
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        yield { kind: 'message_id', id: 9 };
        yield { kind: 'content_delta', content: 'hi' };
        yield { kind: 'usage', inputTokens: 7, outputTokens: 5 };
      },
    });
    const { router } = setup(adapter);
    const resp = await router.create(TOKEN, { ...REQ, stream: true });
    const chunks: any[] = [];
    for await (const c of resp as AsyncIterable<any>) chunks.push(c);
    const withUsage = chunks.filter(c => c.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].usage).toEqual({ prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
    expect(chunks[chunks.length - 1].usage).toBeTruthy();
  });
});

describe('Router review-r1: 失败/中断路径必须销毁线程（不留 busy 幽灵）', () => {
  it('流式中途失败 → mapper 里不残留 busy 线程', async () => {
    let calls = 0;
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        calls++;
        if (calls === 1) { yield { kind: 'message_id', id: 1 }; yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' }; return; }
        yield { kind: 'content_delta', content: 'partial' };
        throw new Error('network down');
      },
    });
    const { router, mapper } = setup(adapter);
    await router.create(TOKEN, REQ) as ChatCompletion;
    // 第二轮走 incremental（markBusy），中途失败
    const resp = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'q'), m('assistant', 'ok'), m('user', 'q2')], stream: true });
    await expect((async () => { for await (const _ of resp as AsyncIterable<unknown>) { /* drain */ } })()).rejects.toThrow();
    expect(mapper.stats()).toEqual({ threads: 0, busy: 0 });
  });

  it('非流式失败 → mapper 里不残留 busy 线程', async () => {
    let calls = 0;
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        calls++;
        if (calls === 1) { yield { kind: 'message_id', id: 1 }; yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' }; return; }
        throw new Error('boom');
      },
    });
    const { router, mapper } = setup(adapter);
    await router.create(TOKEN, REQ) as ChatCompletion;
    await expect(router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'q'), m('assistant', 'ok'), m('user', 'q2')] })).rejects.toThrow();
    expect(mapper.stats()).toEqual({ threads: 0, busy: 0 });
  });
});

describe('Router review-r1: catalog 元素健壮性', () => {
  it('catalog.models 含 null 元素时不抛 TypeError（models.list 仍可用）', async () => {
    const adapter = stubAdapter();
    const { router } = setup(adapter, async (k) => k === 'modelsCatalog'
      ? { capturedAt: Date.now(), models: [null, { label: 'default' }] }
      : undefined);
    await expect(router.models()).resolves.toBeTruthy();
  });
});

describe('Router review-r1: 同名线程排队期间的陈旧 parent', () => {
  it('排队期间线程被推进 → 重新决策（rebuild，不用陈旧 parent 分叉）', async () => {
    const parents: Array<number | string | null> = [];
    let first = true;
    const adapter = stubAdapter({
      streamCompletion: async function* (_ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
        parents.push(req.session.parentMessageId);
        if (first) {
          first = false;
          await new Promise(r => setTimeout(r, 20));
          yield { kind: 'message_id', id: 100 };
          yield { kind: 'content_delta', content: 'r1', finish_reason: 'stop' };
          return;
        }
        yield { kind: 'message_id', id: 200 };
        yield { kind: 'content_delta', content: 'r2', finish_reason: 'stop' };
      },
    });
    const { router } = setup(adapter);
    // 第一轮：建立命名线程 mirror=[u1]，parent=100
    await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1')], conversation_id: 'conv-1' }) as ChatCompletion;
    // 同一命名线程两条并发请求；a 先跑并 commit，b 必须基于新 mirror 重决策
    const a = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1'), m('assistant', 'r1'), m('user', 'u2')], conversation_id: 'conv-1', stream: true });
    const b = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1'), m('assistant', 'r1'), m('user', 'u3')], conversation_id: 'conv-1', stream: true });
    for await (const _ of a as AsyncIterable<unknown>) { /* drain */ }
    for await (const _ of b as AsyncIterable<unknown>) { /* drain */ }
    expect(parents[0]).toBe(null);   // 建会话
    expect(parents[1]).toBe(100);    // a 走增量，父链正确
    expect(parents[2]).toBe(null);   // b 重决策为 rebuild，绝不能是陈旧的 100
  });
});

// 2026-09-11（fix/review-r2）：独立验证发现的回归。
describe('Router review-r2 fixes', () => {
  it('N1: 前缀之后新增 system → 重建全量转录，system 文本一定送达', async () => {
    const prompts: string[] = [];
    const adapter = stubAdapter({
      streamCompletion: async function* (_ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
        prompts.push(req.prompt);
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
      },
    });
    const { router } = setup(adapter);
    await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1')], conversation_id: 'conv-1' }) as ChatCompletion;
    await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1'), m('assistant', 'ok'), m('system', 'S-指令'), m('user', 'u2')], conversation_id: 'conv-1' }) as ChatCompletion;
    expect(prompts[1]).toContain('S-指令');
  });

  it('N2: 排队请求超时不得销毁前面正在跑的会话', async () => {
    const mapperDeletes: string[] = [];
    let calls = 0;
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        calls++;
        if (calls === 2) {   // 第 1 次是建线程的首轮（要快）；第 2 次是 X 的慢流
          await new Promise(r => setTimeout(r, 80));
          yield { kind: 'message_id', id: 1 };
          yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
          return;
        }
        yield { kind: 'content_delta', content: 'ok2', finish_reason: 'stop' };
      },
    });
    const now = vi.fn(() => 1000);
    const mapper = new SessionMapper(
      { createSession: async () => ({ webSessionId: 'x' }), deleteSession: async (id) => { mapperDeletes.push(id); }, now },
      { poolSize: 5, ttlMs: 60_000 },
    );
    const router = new Router({
      registry: { deepseek: adapter },
      mapper,
      queue: new Queue({ timeoutMs: 20, now }),
      storage: { get: async () => undefined },
      log: new RingLog(50),
      now,
      version: '0.0.0-test',
    });
    await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1')], conversation_id: 'conv-1' }) as ChatCompletion;
    const x = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1'), m('assistant', 'ok'), m('user', 'u2')], conversation_id: 'conv-1', stream: true });
    const xdrain = (async () => { for await (const _ of x as AsyncIterable<unknown>) { /* drain */ } })();
    await new Promise(r => setTimeout(r, 5));
    const y = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'u1'), m('assistant', 'ok'), m('user', 'u3')], conversation_id: 'conv-1', stream: true });
    await expect((async () => { for await (const _ of y as AsyncIterable<unknown>) { /* drain */ } })()).rejects.toMatchObject({ status: 429 });
    await xdrain;
    expect(mapperDeletes).not.toContain('s1');
  });
});
