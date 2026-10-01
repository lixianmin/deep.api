// 2026-10-01（stage-a/decouple-dsml）：阶段 A 第 1 步——DSML 归一化从 router 下沉到 adapter。
//
// 改动前：router 顶层 import `createDsmlStreamNormalizer`，不论 adapter 是否需要都建归一化器。
// 改动后：router 通过 `provider.normalizeContent?.()` 询问 adapter；adapter 不实现 = 原样透传。
// 行为契约保持不变（DeepSeek adapter 必须继续归一化），对外字节级无差异。
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import { createDeepSeekAdapter, type AdapterDeps } from '../../src/background/providers/deepseek/adapter';
import { DSML_TOKEN, createDsmlStreamNormalizer } from '../../src/background/providers/deepseek/dsml-parser';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { Message, ToolDef } from '../../src/shared/api-types';

const T = DSML_TOKEN;
const m = (role: Message['role'], content: string): Message => ({ role, content });
const TOKEN = 'tok';

// 与 tests/integration/router.test.ts 同一形状的 stub——复刻 router 集成测试的 setup 范式，
// 不另起炉灶（brief 第 2 条）。
function stubAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  let seq = 0;
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', cookieDomain: 'chat.deepseek.com', requiredCookies: [], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: `s${++seq}`, parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { kind: 'message_id', id: 1 };
      yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
    },
    models: [{ id: 'deepseek-flash', provider: 'deepseek', description: 'flash' }],
    resolveModel: (id: string) => id === 'deepseek-flash'
      ? { modelId: id, modelType: 'default' as const, supportsImages: false, thinking: true, limitChars: 2_621_440 }
      : null,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    ...over,
  };
  return base;
}

function makeRouter(adapter: ProviderAdapter) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 5, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 5_000, now }),
    storage: { get: async () => undefined },
    log: new RingLog(50),
    now,
    version: '0.0.0-test',
    // 入口限流：单测默认关，避免连发请求被节流。
    minRequestIntervalMs: 0,
    jitterMs: 0,
  });
  return router;
}

const READ: ToolDef[] = [{ type: 'function' as const, function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

/** 与 router.test.ts 一致的 chunk 收集：把 stream 里所有 content/tool_calls 都聚合出来。 */
async function drainStream(iterable: AsyncIterable<unknown>): Promise<{ content: string; toolCalls: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>; finish: string | null }> {
  const out: { content: string; toolCalls: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>; finish: string | null } = { content: '', toolCalls: [], finish: null };
  for await (const c of iterable as AsyncIterable<any>) {
    const d = c?.choices?.[0]?.delta ?? {};
    if (typeof d.content === 'string') out.content += d.content;
    if (Array.isArray(d.tool_calls)) out.toolCalls.push(...d.tool_calls);
    if (c?.choices?.[0]?.finish_reason) out.finish = c.choices[0].finish_reason;
  }
  return out;
}

describe('阶段 A · adapter.normalizeContent 接管 DSML 归一化', () => {
  // —— Step 1 / Step 2 ——
  // 不实现 normalizeContent 的 adapter：DSML 字面量必须原样透传到 content。
  // 当前实现直接 import 归一化器、无条件调用 → 标记在流上被改写成标准 tool_calls JSON →
  // `drained.content` 拿到的是重写后的标准形态而非 DSML 字面量 → 此测试当前应失败。
  // 重构后 router 走 `provider.normalizeContent?.()`，未实现返回 undefined → null → 流上不归一化 →
  // DSML 字面量原样抵达客户端（注：流末 parseToolCalls 仍能把 DSML 解成结构化 tool_call，
  // 这是 tool-pipeline.ts 的能力，不在本次重构范围内；本用例只看流上是否原样透传）。
  it('失败→通过：无 normalizeContent 的 adapter → DSML 字面量原样透传到 content', async () => {
    const literal = `<${T}tool_calls>\n<${T}invoke name="Read">\n<${T}parameter name="path" string="true">x</${T}parameter>\n</${T}invoke>\n</${T}tool_calls>`;
    // stubAdapter 默认不带 normalizeContent；这里再保险一次，断言它真不存在。
    // streamCompletion 必须吐 DSML 字面量——默认 stub 返 'ok'，得覆盖。
    const adapter = stubAdapter({
      streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: literal, finish_reason: 'stop' };
      },
    });
    expect(adapter.normalizeContent).toBeUndefined();
    const router = makeRouter(adapter);
    const s = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'q')], tools: READ, stream: true, conversation_id: 'passthrough' });
    const drained = await drainStream(s as AsyncIterable<unknown>);
    // 字面量必须整段出现在 content（不被流上归一化成标准 tool_calls JSON）
    expect(drained.content).toContain(`<${T}tool_calls>`);
    expect(drained.content).toContain(`<${T}invoke`);
    expect(drained.content).not.toMatch(/<tool_calls>[\s\S]*Read/);   // 没被重写成标准 tool_calls
  });

  // —— Step 3 ——
  // 无 tools 时 router 不得调用 adapter.normalizeContent；有 tools 时调 1 次。
  // 「tools=空 ⇒ 不调归一化器」是 Stage-A 抽象的边界条件（spec 评审 R2）——归一化器只为「有工具请求」而生，
  // 纯聊天场景绝不能白白构造它。
  // 改动前：router 直接 import 归一化器，与 adapter 解耦无关 → adapter.normalizeContent 永不被调 → 计数器第二行失败。
  // 改动后：router 走 `provider.normalizeContent?.()`，未实现返回 undefined → 第二行计数器累到 1。
  // 注：encodeStream 是 async generator，`normalizeContent` 调用发生在生成器体内——必须把流消费完才计数。
  it('失败→通过：无 tools 不调 normalizeContent；有 tools 调 1 次', async () => {
    let calls = 0;
    // adapter 暴露 normalizeContent 钩子，挂在计数器上——直接返回 null 不参与归一化，专注计数。
    const adapter = stubAdapter({
      normalizeContent: () => { calls++; return null; },
    });
    const router = makeRouter(adapter);
    // 第 1 轮：无 tools → promptSuffix === '' → router 不得调 normalizeContent
    const s1 = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'q1')], stream: true, conversation_id: 'no-tools-1' });
    for await (const _ of s1 as AsyncIterable<unknown>) { void _; }
    expect(calls).toBe(0);
    // 第 2 轮：有 tools → router 调 1 次
    const s2 = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', 'q1'), m('user', 'q2')], tools: READ, stream: true, conversation_id: 'no-tools-2' });
    for await (const _ of s2 as AsyncIterable<unknown>) { void _; }
    expect(calls).toBe(1);
  });

  // —— Step 4 ——
  // 合法 DSML 块：归一化器一次成功 → unparsed/dropped 均为空 → 成功路径不触发 repair。
  // 锁住「空块 repair」（v0.2.6 修复后行为）——如果某天有人把 heldBack 收窄/放宽改变这块语义，本用例会断。
  // 观察判据：streamCompletion 只调 1 次（repair 会触发第 2 次）+ 客户端拿到 1 个 tool_calls 增量。
  it('护栏：合法 DSML 块 → 归一化成功、不走 repair', async () => {
    const validDSML = `<${T}tool_calls>\n<${T}invoke name="Read">\n<${T}parameter name="path" string="true">a.ino</${T}parameter>\n</${T}invoke>\n</${T}tool_calls>`;
    let streamCalls = 0;
    const adapter = stubAdapter({
      // 显式归一化器（与 DeepSeek adapter 等价），让归一化路径真实跑起来
      normalizeContent: (tools) => createDsmlStreamNormalizer(tools),
      streamCompletion: async function* (_ctx: ProviderContext, _req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
        streamCalls++;
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: validDSML, finish_reason: 'stop' };
      },
    });
    const router = makeRouter(adapter);
    const s = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', '读 a.ino')], tools: READ, stream: true, conversation_id: 'happy' });
    const drained = await drainStream(s as AsyncIterable<unknown>);
    // 关键断言 1：streamCompletion 只调 1 次（成功路径不走 repair；repair 会再调 1 次）
    expect(streamCalls).toBe(1);
    // 关键断言 2：客户端拿到 1 个结构化 tool_calls 增量，且名字/参数正确
    expect(drained.toolCalls).toHaveLength(1);
    expect(drained.toolCalls[0]!.function?.name).toBe('Read');
    expect(JSON.parse(drained.toolCalls[0]!.function?.arguments ?? '{}')).toEqual({ path: 'a.ino' });
  });

  // —— Step 5 ——
  // 真实 DeepSeek adapter：相同 DSML 输入，下游仍收到标准 tool_calls（行为不变）。
  // 这是「阶段 A 不改对外行为」的机器可验证表达——一旦 DeepSeek 适配层漏接 normalizeContent，
  // 客户端就会看到 DSML 原样透传，下游 spice 解析失败 → 本用例立刻红。
  it('护栏：真实 createDeepSeekAdapter 仍归一化 DSML → 下游是标准 tool_calls', async () => {
    const validDSML = `<${T}tool_calls>\n<${T}invoke name="Read">\n<${T}parameter name="path" string="true">b.ino</${T}parameter>\n</${T}invoke>\n</${T}tool_calls>`;
    // 走真实 SSE 协议：ready → RESPONSE fragment（携带 DSML 文本）→ FINISHED。
    // 解析器会把 fragment.content 当 content_delta 推给 router，router 再过归一化器。
    const sse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n',
      `data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":${JSON.stringify(validDSML)}}]}}}\n\n`,
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const deps: AdapterDeps = {
      getToken: async () => 'tok',
      // streamCompletion 之前会 createSession（POST /chat_session/create + /chat_session/delete），
      // 必须返回带 chat_session.id 的 payload；DSML 解析本身只走 fetchStream。
      fetchJson: async (path: string) => {
        if (path === '/chat_session/create') return { data: { chat_session: { id: 'sess-real' } } };
        if (path === '/chat_session/delete') return { data: null };
        throw new Error(`unexpected fetchJson path=${path}`);
      },
      fetchStream: async () => ({
        status: 200, headers: new Headers(),
        body: (async function* () { yield new TextEncoder().encode(sse); })() as unknown as AsyncIterable<Uint8Array>,
      }),
      // pow mock：streamCompletion 会调 pow 拿 challenge；mock 出来即可，不影响 DSML 路径。
      pow: { getChallenge: async () => ({}), solve: async () => 'pow-ok' } as any,
      now: () => 0,
    };
    const adapter = createDeepSeekAdapter(deps);
    const router = makeRouter(adapter);
    const s = await router.create(TOKEN, { model: 'deepseek-flash', messages: [m('user', '读 b.ino')], tools: READ, stream: true, conversation_id: 'real-dsml' });
    const drained = await drainStream(s as AsyncIterable<unknown>);
    // 标准 tool_calls JSON 已重写，原 DSML 标记已剥离
    expect(drained.content).not.toMatch(/dsml/i);
    expect(drained.content).toContain('<tool_calls>');
    expect(drained.content).toContain('</tool_calls>');
    expect(drained.toolCalls).toHaveLength(1);
    expect(drained.toolCalls[0]!.function?.name).toBe('Read');
    expect(JSON.parse(drained.toolCalls[0]!.function?.arguments ?? '{}')).toEqual({ path: 'b.ino' });
  });
});
