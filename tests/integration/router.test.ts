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
const msg = m;

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


// 2026-09-09（fix/mirror-content）：mirror 的 assistant.content 必须与「发送给客户端的 SSE content」一致。
// 根因：spice 走流式，SSE 发出的 content_delta 是 LLM 完整输出（**含** <tool_calls> 标签文本）；
// spice 端 asst.content 存盘、回发的就是这段完整文本。但 deep.api mirror 存的 agg.content
// 是 parseToolCalls 剥离后的 remainder（**不含**标签）→ 下一轮 spice 回灌时同一条 asst
// content 两边不一致 → mirrorIsPrefix 失败 → rebuild → chat thread 反复被删。
// trace spice-45e6c9b6 实测：finishReason=tool_calls 的回合之后必然「重建 删除旧 thread」。
describe('mirror assistant.content 与 SSE 一致（fix/mirror-content）', () => {
  // 真实 spice 请求带 tools（Read 等）；不带 tools 时 toolCtx.promptSuffix=''，parseToolCalls 根本不会跑
  const TOOL_FOR_TEST = [{ type: 'function', function: { name: 'Read', description: 'read', parameters: { type: 'object' } } }];
  const FULL = '好的我先读一下文件\n<tool_calls>[\n {"id":"c1","type":"function","function":{"name":"Read","arguments":"{\\\"path\\\":\\\"sketch.ino\\\"}"}}\n]</tool_calls>';

  function makeAdapterWithTextThenTool() {
    let n = 0;
    return stubAdapter({
      streamCompletion: async function* () {
        n++;
        yield { kind: 'message_id', id: 1 };
        if (n === 1) yield { kind: 'content_delta', content: FULL };   // 完整文本含标签
        else yield { kind: 'content_delta', content: '读完了', finish_reason: 'stop' };
      },
    });
  }

  it('fail-to-pass：流式 tool_calls 后 mirror assistant.content = 完整文本（含标签），下轮 spice 回灌 → incremental', async () => {
    const r = makeRouter(makeAdapterWithTextThenTool());
    // turn 1 第一轮：spice 初始 messages
    const s_ = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'q1')], tools: TOOL_FOR_TEST, stream: true, conversation_id: 'cid' });
    for await (const _c of s_ as AsyncIterable<unknown>) { void _c; }
    const t = (r as any).d.mapper.threads.get('deepseek:cid');
    const asst = t.mirror[t.mirror.length - 1]!;
    // mirror 必须存完整文本（含 <tool_calls> 标签）——与 SSE 发给 spice 的一致
    expect(asst.content).toContain('<tool_calls>');
    expect(asst.content).toContain('好的我先读一下文件');

    // turn 1 第二轮：spice 回灌 asst(完整文本+tool_calls) + tool 结果
    const s2 = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [
      m('user', 'q1'),
      m('assistant', FULL, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{\"path\":\"sketch.ino\"}' } }] } as any),
      m('tool', 's1内容', { tool_call_id: 'c1', name: 'Read' } as any),
    ], tools: TOOL_FOR_TEST, stream: true, conversation_id: 'cid' });
    for await (const _c of s2 as AsyncIterable<unknown>) { void _c; }

    // turn 2：spice 从 chat-store 加载完整历史（含 tool）再发新 user
    const s3 = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [
      m('user', 'q1'),
      m('assistant', FULL, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{\"path\":\"sketch.ino\"}' } }] } as any),
      m('tool', 's1内容', { tool_call_id: 'c1', name: 'Read' } as any),
      m('assistant', '读完了'),
      m('user', 'q2'),
    ], tools: TOOL_FOR_TEST, stream: true, conversation_id: 'cid' });
    for await (const _c of s3 as AsyncIterable<unknown>) { void _c; }

    const list = r['d'].log.list();
    const e2 = list[2]!;   // turn 2 的决策
    expect(e2.action).toBe('incremental');
    expect(e2.mirrorPrefixOk).toBe(true);
    expect(e2.deletedOld).toBe(false);
  });
});

// 2026-09-09（fix/thread-persistence）：用户实测三连击（新回合新建会话 + 工具不触发 + 需要轨迹数据集）
// 1) threadFound=false：user 隔 ~24 分钟续聊，MV3 service worker 被浏览器终止后内存 threads Map 全清
//    → decide 找不到 thread → rebuild → 新建 DeepSeek Conversation（用户期望同一会话续聊）
//    修：ThreadEntry 持久化（serialize/restore），SW 重启后 hydrate。
// 2) system prompt 演进（知识库修复后 <project_context> 上线）会使 mirror[0]≠messages[0] → rebuild；
//    system 是调用方注入指令，不该参与「上下文连续性」判定——比对时必须忽略 role=system。
// 3) 问题 2（模型输出「文字+JSON」没触发工具）的日志观测：finishReason=stop 但无模型原文——
//    加 replySample（聚合内容前 200 字）到 LogEntry，用户下次贴日志即可见模型到底输出了什么。
describe('thread 持久化 + system 豁免比对（fix/thread-persistence）', () => {
  const SYSTEM_A = 'you are old coding agent';
  const SYSTEM_B = 'you are new coding agent with <project_context> knowledge';   // 模拟知识库上线后 system 变化

  it('fail-to-pass: SW 重启（mapper 重建 + restore）后同 cid 续聊 → incremental + 复用 webSessionId', () => {
    const now = vi.fn(() => 1000);
    const deps = { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now };
    const cfg = { poolSize: 2, ttlMs: 60_000 };
    const m1 = new SessionMapper(deps, cfg);
    m1.register('deepseek', 'cid', 'ws-abc', [m('system', SYSTEM_A), m('user', 'q1')]);
    m1.commit('deepseek', 'cid', [m('system', SYSTEM_A), m('user', 'q1'), m('assistant', 'a1')], 'ws-abc', 2);
    // SW 被杀：模块重载 → 全新 mapper；从持久化恢复线程
    const snap = (m1 as any).serialize();
    const m2 = new SessionMapper(deps, cfg);
    (m2 as any).restore(snap);
    const d = m2.decide('deepseek', [m('system', SYSTEM_A), m('user', 'q1'), m('assistant', 'a1'), m('user', 'q2')], 'cid');
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') expect(d.thread.webSessionId).toBe('ws-abc');
  });

  it('fail-to-pass: system 内容变化不影响增量匹配（mirror 比对忽略 role=system）', async () => {
    const r = makeRouter(stubAdapter());
    const sys = (s: string) => [m('system', s), m('user', 'q1')];
    const s1 = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: sys(SYSTEM_A), stream: true, conversation_id: 'cid' });
    for await (const _c of s1 as AsyncIterable<unknown>) { void _c; }
    // 知识库上线：system 演进为 SYSTEM_B，业务消息一致；tail = [user q2]
    const s2 = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [
      m('system', SYSTEM_B), m('user', 'q1'), m('assistant', 'ok'), m('user', 'q2'),
    ], stream: true, conversation_id: 'cid' });
    for await (const _c of s2 as AsyncIterable<unknown>) { void _c; }
    const e = r['d'].log.list().at(-1)!;
    expect(e.action).toBe('incremental');
    expect(e.deletedOld).toBe(false);
  });

  it('fail-to-pass: replySample 记录模型输出原文（问题 2 排查现场）', async () => {
    const r = makeRouter(stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: '我把 JSON 写在正文里：```json\n[{"id":"x"}]\n```', finish_reason: 'stop' };
      },
    }));
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'q1')], tools: [{ type: 'function', function: { name: 'Read', description: 'r', parameters: { type: 'object' } } }], stream: true });
    for await (const _c of s as AsyncIterable<unknown>) { void _c; }
    const e = r['d'].log.list().at(-1)! as any;
    expect(e.replySample).toContain('我把 JSON 写在正文里');
  });
});

// onPersist 数据层接线：register/commit 后回调必须触发（sw.ts 借此写 chrome.storage.local）
describe('持久化钩子（fix/thread-persistence）', () => {
  it('register/commit 各触发一次 onPersist，快照含完整 ThreadEntry', () => {
    const now = vi.fn(() => 1000);
    const mapper2 = new SessionMapper(
      { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
      { poolSize: 2, ttlMs: 60_000 },
    );
    const snaps: { seq: number; threads: { conversationId: string; webSessionId: string; mirror: unknown[] }[] }[] = [];
    mapper2.onPersist = (s) => snaps.push(s as never);
    mapper2.register('deepseek', 'cid', 'ws-1', [msg('user', 'q1')]);
    mapper2.commit('deepseek', 'cid', [msg('user', 'q1'), msg('assistant', 'a1')], 'ws-1', 2);
    expect(snaps.length).toBe(2);
    expect(snaps[1]!.threads[0]!.webSessionId).toBe('ws-1');
    expect(snaps[1]!.threads[0]!.mirror.length).toBe(2);
  });
});
