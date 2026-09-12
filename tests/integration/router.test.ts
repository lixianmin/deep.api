import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { Message } from '../../src/shared/api-types';
import { resolveModel as clientResolveModel } from '../../src/background/providers/deepseek/client';
import { DSML_TOKEN } from '../../src/background/providers/deepseek/dsml-parser';

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
      ? { modelId: id, modelType: 'default' as const, supportsImages: false, thinking: false, limitChars: 2_621_440 }
      : id === 'deepseek-v4-pro'
        ? { modelId: id, modelType: 'expert' as const, supportsImages: false, thinking: true, limitChars: 163_840 }
        : id === 'deepseek-v4-flash-vision-exp'
          ? { modelId: id, modelType: 'vision' as const, supportsImages: true, thinking: false, limitChars: 2_621_440 }
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
    storage: { get: async () => undefined },
    log: new RingLog(20),
    now,
    // 2026-09-09（diag/version-stamp）：log 条目自证构建版本。Debug 页「复制完整 JSON」
    // 时直接看到 version，不用再问用户装的是哪个版本。
    version: '0.0.0-test',
  });
  return router;
}

const TOKEN = 'tok-from-cookie';

describe('Router', () => {
  // 2026-09-09（diag/version-stamp）：给 log 条目打构建版本戳。用户「重装后日志没有新字段」
  // 只能靠日志自证：version 字段直接显示运行的扩展构建版本（来自 manifest），
  // 避免再猜 Chrome 到底加载了哪个 sw.js（v0.1.66/v0.1.67 教训：没 build 或旧代码在跑）。
  it('diagnose: log 条目带 version 字段（自证构建版本）', async () => {
    const r = makeRouter(stubAdapter());
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    const e = r['d'].log.list().at(-1)!;
    expect(e.version).toBe('0.0.0-test');
  });

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

  // 2026-09-14（fix/accept-v4-flash-alias）：下游仍发 retired 的 `deepseek-v4-flash`，
  // v0.1.87 砍掉 resolveModel 后变 400 `unknown model`。用**真实 client.resolveModel**
  // 走 router.create，复现并锁死“旧 ID 走兼容解析、不再 400”。
  it('accepts retired chat ID deepseek-v4-flash via compat resolution (no 400)', async () => {
    const r = makeRouter(stubAdapter({ resolveModel: (id: string) => clientResolveModel(id) }));
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(res.choices[0].message.content).toBe('ok');
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

  // 2026-09-09（fix/model-switch-rebuild）：同一 conversation_id 中途切模型 → mapper 必须 detect
  // 到 modelType 变化 → 走 rebuild 路径（deleteSession + createSession + 完整历史作为 prompt）。
  // DeepSeek 网页 web API 本身不允许一个 chat thread 中途换模型（聊天前定模型）；reuse 旧 session
  // 会让 model_type 与 parent_message_id 链不一致，行为未定义。
  // 修：ThreadEntry 存 modelType，decide() 比对请求的 resolved.modelType vs 存储的 modelType，
  // 不一致 → 返回 {action:'rebuild', existing: thread}，复用现有 cid 让客户端无感。
  it('fail-to-pass: 同 cid 中途切模型（flash → pro）→ rebuild + 完整历史作为 prompt', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    // round 1: flash，commit，mirror = [user:q1, asst:ok]
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'q1')], conversation_id: 'cid' });
    // round 2: 同 messages 尾巴 + user:q2，但 model 切到 pro
    await r.create(TOKEN, { model: 'deepseek-v4-pro', messages: [m('user', 'q1'), m('assistant', 'ok'), m('user', 'q2')], conversation_id: 'cid' });

    const log = r['d'].log.list();
    expect(log).toHaveLength(2);
    const e2 = log[1]!;
    // 关键断言：模型不一致 → 必须 rebuild（不是 incremental）
    expect(e2.action).toBe('rebuild');
    expect(e2.deletedOld).toBe(true);   // 旧 s1 被 delete
    expect(e2.threadFound).toBe(true); // 但 mapper 里还是能找到 thread（existing 非空）

    // 关键断言：round 2 发出的是完整历史（rebuild 路径用 renderTranscript 拼全部 user/tool），
    // 不是增量 tail「q2」——否则切模型后上下文丢了。
    const prompts = (a as any).prompts as string[];
    expect(prompts[1]).toContain('q1');
    expect(prompts[1]).toContain('q2');
    expect(prompts[1]).not.toBe('q2');   // 必须不是增量
  });

  it('fail-to-pass: 同模型 round 2 仍然 incremental（不要 over-rebuild）', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'q1')], conversation_id: 'cid' });
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'q1'), m('assistant', 'ok'), m('user', 'q2')], conversation_id: 'cid' });
    const e2 = r['d'].log.list()[1]!;
    expect(e2.action).toBe('incremental');
    expect(e2.deletedOld).toBe(false);
    // round 2 是增量，prompt 只含尾部 user:q2
    expect((a as any).prompts[1]).toBe('q2');
  });

  // 2026-09-09（diag/reasoning-sample）：spice 用户报 Pro 模式返回空 content 但 finishReason=stop。
  // 强烈怀疑 Pro（model_type=expert）在 DeepSeek 网页 web API 上只返回 thinking/reasoning，不返回
  // content（与 Flash 默认 false 不同）。当前 log 只记 replySample（content），reasoning 被静默丢，
  // 排查现场看不见。修：log 同时记 reasoningSample（agg.reasoning 前 200 字），看一眼就能锁定。
  it('fail-to-pass: Pro 风格「只返回 thinking」响应 → log 记下 reasoningSample 与 replySample 同时可见', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'think_delta', content: '用户问「只是测试」，是简单请求。' };
        yield { kind: 'think_delta', content: '我应该简洁回个 OK。' };
        // 注意：没有 content_delta，模拟 Pro 只输出 thinking 不输出 content 的场景
        yield { kind: 'content_delta', content: '', finish_reason: 'stop' };
      },
    });
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-pro', messages: [m('user', '只是测试一下')] });
    const e = r['d'].log.list()[0]!;
    expect(e.replySample).toBe('');
    expect(e.reasoningSample).toContain('用户问');
    expect(e.reasoningSample).toContain('OK');
    expect(e.finishReason).toBe('stop');
    expect(e.ok).toBe(true);
  });

  it('fail-to-pass: Flash 风格「只返回 content」响应 → reasoningSample 仍记下（即使为空）便于现场排查', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: '你好', finish_reason: 'stop' };
      },
    });
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    const e = r['d'].log.list()[0]!;
    expect(e.replySample).toBe('你好');
    expect(e.reasoningSample).toBe('');   // Flash 不发 thinking
  });

  // 2026-09-09（diag/pro-sse-paths）：spice 报 Pro 返空 content + reasoning，疑似 Pro 上游仅返
  // thinking 片段不接 content。诊断：SSE parser 跟踪总字节与 path 集，log 记 sseBytes/ssePaths。
  //   bytes=0 + paths=[] → 上游完全未返 (B-3)
  //   bytes>0 + paths 只含 'ready'+'response/fragments'  →  Pro 只返了 fragments
  //   bytes>0 + paths 含 'unknown:xxx'                   →  Pro 返了未识别 path
  it('fail-to-pass: stream 末 emit stream_stats → log 记 sseBytes/ssePaths（Pro 场景 B-1/B-2 区分用）', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: 'hi', finish_reason: 'stop' };
        yield { kind: 'stream_stats', bytes: 2048, paths: ['ready', 'response/content'] };
      },
    });
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    const e = r['d'].log.list()[0]!;
    expect(e.sseBytes).toBe(2048);
    expect(e.ssePaths).toEqual(['ready', 'response/content']);
  });

  // 2026-09-09（fix/encode-stream-stats）：v0.1.69/70 在 encodeStream 里漏了 stream_stats case，
  // 导致 stream 路径下 log.sseBytes/ssePaths 永远 undefined（non-stream 路径走 consumeEvent
  // 是对的）。用户实测 Debug 页 chat tab 的 Pro 请求：ok=true 但 log 缺这俩字段。
  // 修：encodeStream 内联累加逻辑补 case。非流/流两路径一致写 run.sseBytes/ssePaths。
  it('fail-to-pass: stream:true 路径上 stream_stats → log 同样记 sseBytes/ssePaths', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: 'hi', finish_reason: 'stop' };
        yield { kind: 'stream_stats', bytes: 4096, paths: ['ready', 'response/thinking_content', 'response/content'], rawSample: '{"unknown":"xxx"}' };
      },
    });
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-pro', messages: [m('user', '这是个测试')], stream: true });
    for await (const _ of s as AsyncIterable<unknown>) { void _; }
    const e = r['d'].log.list().at(-1)!;
    expect(e.sseBytes).toBe(4096);
    expect(e.ssePaths).toEqual(['ready', 'response/thinking_content', 'response/content']);
    // 2026-09-09（diag/raw-sample 现场 B）：encodeStream 尾部 done 调用漏传 sseRaw——v0.1.73/74
    // 用户实测 version=0.1.74 但日志无 sseRaw（连空串都没有）：sseBytes/ssePaths 有值、sseRaw 缺失
    // 组合只有一种解释——流路径 done 没带这字段。修：line 322 done 补 sseRaw: handle.run.sseRaw。
    expect(e.sseRaw).toBe('{"unknown":"xxx"}');
  });

  it('fail-to-pass: Pro 风格「只返 thinking fragments」→ paths 只含 response/fragments (B-1 现场)', async () => {
    // 模拟 Pro 返了 thinking 但不接 content：parser 会看到 ready + response/fragments path
    // （parser 走的是 response/fragments path，因为 Pro 不走 response/content 老路径）
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'think_delta', content: '用户问只是测试' };
        // 没 content_delta
        yield { kind: 'content_delta', content: '', finish_reason: 'stop' };
        yield { kind: 'stream_stats', bytes: 4096, paths: ['ready', 'response/fragments'] };
      },
    });
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-pro', messages: [m('user', '只是测试')] });
    const e = r['d'].log.list()[0]!;
    expect(e.replySample).toBe('');
    expect(e.reasoningSample).toBe('用户问只是测试');
    expect(e.sseBytes).toBe(4096);
    expect(e.ssePaths).toContain('ready');
    expect(e.ssePaths).toContain('response/fragments');
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

// 2026-09-09（fix/vision-rejection）：网页 web API 的 completion body `prompt` 是单字符串，
// 不接受 OpenAI 风格 `messages[].content` 数组（含 `image_url` block）。视觉模型 `ref_file_ids`
// 永远是 `[]`（client.ts 硬编码），渲染器会把 array content 静默吞为 `[object Object]` →
// DeepSeek 视觉侧返空 → 客户端没有任何 SSE 事件也看不到错误（spice 实测：网页里看不到新 session）。
// 入口处显式拒绝非字符串 content，返回 400 让客户端立刻知道视觉未启用（spec §6.3：vision v1 不接入）。
describe('Router vision content 拒绝（fix/vision-rejection）', () => {
  it('fail-to-pass: 视觉模型 + array content（image_url）→ 400 invalid_request_error，不调 streamCompletion', async () => {
    let called = 0;
    const a = stubAdapter({
      streamCompletion: async function* () { called++; yield { kind: 'content_delta', content: 'should-not-happen', finish_reason: 'stop' }; },
    });
    const r = makeRouter(a);
    const imageMsg: any = {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
      ],
    };
    await expect(r.create(TOKEN, {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [imageMsg],
    })).rejects.toMatchObject({
      status: 400,
      error: { error: { code: 'invalid_request_error' } },
    });
    // 关键：拒绝必须在创建会话/发起请求之前——否则 DeepSeek 网页端会出现空 session
    expect(called).toBe(0);
  });

  it('fail-to-pass: 错误信息点名 vision 模型 + v2 计划', async () => {
    const r = makeRouter(stubAdapter());
    const imageMsg: any = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }],
    };
    try {
      await r.create(TOKEN, { model: 'deepseek-v4-flash-vision-exp', messages: [imageMsg] });
      throw new Error('should have thrown');
    } catch (e: any) {
      const msg = e?.error?.error?.message ?? '';
      expect(msg).toMatch(/vision|visual|图像|视觉/i);
    }
  });

  it('非视觉模型 + array content 同样拒绝（renderer 永远不接受 array content）', async () => {
    const r = makeRouter(stubAdapter());
    const imageMsg: any = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }],
    };
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [imageMsg] })).rejects.toMatchObject({
      status: 400,
      error: { error: { code: 'invalid_request_error' } },
    });
  });

  it('字符串 content 仍正常工作（回归保护）', async () => {
    const a = stubAdapter();
    const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash-vision-exp', messages: [m('user', '你是视觉模型吗')] });
    // vision 模型 + 纯文本应该照常工作（DeepSeek 视觉模型支持纯文本输入；只是不支持 in-line image）
    expect(res.choices[0].message.content).toBe('ok');
  });
});

// 2026-09-09（feat/diagnostic-logging）：popup 日志区需要的诊断现场。
// spice 报“每发一条消息重建一条”需看 threadFound / deletedOld / action 判断“多次调中有无轮番 rebuild 删 old”。
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

  it('传同 cid 第二次调 → incremental、threadFound=true、msgsLen 递增', async () => {
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
// 2026-09-09（fix/persist-debounce）：register + commit 在 100ms 内合并为 1 次 onPersist。
describe('持久化钩子（fix/thread-persistence + fix/persist-debounce）', () => {
  it('register+commit 在 100ms 内合并为一次 onPersist，快照含最终 mirror', async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      const mapper2 = new SessionMapper(
        { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now: () => now },
        { poolSize: 2, ttlMs: 60_000 },
      );
      const snaps: { seq: number; threads: { conversationId: string; webSessionId: string; mirror: unknown[] }[] }[] = [];
      mapper2.onPersist = (s) => snaps.push(s as never);

      mapper2.register('deepseek', 'cid', 'ws-1', [msg('user', 'q1')]);
      mapper2.commit('deepseek', 'cid', [msg('user', 'q1'), msg('assistant', 'a1')], 'ws-1', 2);

      // 100ms 内 debounce timer 未触发 → onPersist 0 次
      expect(snaps.length).toBe(0);
      // 推进 fake timer 100ms 让 debounce 触发
      now += 100;
      await vi.runAllTimersAsync();
      // 合并后只写一次，快照含最终 mirror（2 条）
      expect(snaps.length).toBe(1);
      expect(snaps[0]!.threads[0]!.webSessionId).toBe('ws-1');
      expect(snaps[0]!.threads[0]!.mirror.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-09-10（fix/dsml-tool-parser）：DeepSeek V4 原生工具协议 DSML（<｜DSML｜tool_calls>…）。
// 修复前：tool-pipeline 里的 DSML 正则写的是小写 <｜dsml｜tool_calls> + 错误结束标签 <｜dsml｜>，
// 永远匹配不上真货 → hasToolTags=false → 流式路径判定「模型没调工具」→ DSML 原样透传给 spice、
// finish_reason 记成 stop。修复后：归一化器把 DSML 块重写成标准 <tool_calls> JSON，
// 并按既有路径产出结构化 tool_calls。
describe('DSML 工具调用归一化（fix/dsml-tool-parser）', () => {
  const T = DSML_TOKEN;
  const TOOL = [{ type: 'function' as const, function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } } } }];
  // vLLM docstring 形态：块 + invoke + string="true"/string="false" 参数
  const DELTAS = [
    '好的我读一下\n',
    `<${T}tool_calls>\n`,
    `<${T}invoke name="Read">\n`,
    `<${T}parameter name="path" string="true">sketch.ino</${T}parameter>\n`,
    `<${T}parameter name="limit" string="false">200</${T}parameter>\n`,
    `</${T}invoke>\n`,
    `</${T}tool_calls>`,
  ];

  it('fail-to-pass: 流式 DSML → content 是标准 <tool_calls>（不含 DSML），tool_calls 结构化产出', async () => {
    const adapter = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        for (const d of DELTAS) yield { kind: 'content_delta', content: d };
      },
    });
    const r = makeRouter(adapter);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'dsml-cid' });
    const contents: string[] = [];
    const calls: any[] = [];
    for await (const c of s as AsyncIterable<any>) {
      const d = c.choices[0].delta;
      if (typeof d.content === 'string') contents.push(d.content);
      if (d.tool_calls) calls.push(...d.tool_calls);
    }
    const text = contents.join('');
    expect(text).toContain('好的我读一下');
    expect(text).toContain('<tool_calls>');
    expect(text).toContain('</tool_calls>');
    expect(text).not.toMatch(/dsml/i);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Read');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'sketch.ino', limit: 200 });
    // mirror 存的就是发给客户端的文本（v0.1.91 一致性决策）→ 下轮 spice 回灌可 incremental
    const thread = (r as any).d.mapper.threads.get('deepseek:dsml-cid');
    const asst = thread.mirror[thread.mirror.length - 1]!;
    expect(asst.content).not.toMatch(/dsml/i);
    expect(asst.content).toContain('<tool_calls>');
    expect(asst.tool_calls[0].function.name).toBe('Read');
  });

  // 2026-09-10（fix/dsml-tolerant-closes）：用户 v0.1.96 现场真实形态——开标签带命名空间、
  // 闭标签不带（</parameter> / </invoke>），解析器完全接不住。这个用例固定住回归。
  it('fail-to-pass: 闭标签省略命名空间的混合形态 → 同样归一化成标准 <tool_calls>', async () => {
    const hybrid =
      `<${T}tool_calls>\n` +
      `<${T}invoke name="Read">\n` +
      `<${T}parameter name="path" string="true">sketch.ino</parameter>\n` +
      `</invoke>\n` +
      `</${T}tool_calls>`;
    const adapter = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: hybrid };
      },
    });
    const r = makeRouter(adapter);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'dsml-hybrid' });
    const contents: string[] = [];
    const calls: any[] = [];
    for await (const c of s as AsyncIterable<any>) {
      const d = c.choices[0].delta;
      if (typeof d.content === 'string') contents.push(d.content);
      if (d.tool_calls) calls.push(...d.tool_calls);
    }
    const text = contents.join('');
    expect(text).not.toMatch(/dsml/i);
    expect(text).toContain('<tool_calls>');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Read');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'sketch.ino' });
  });
});

// 2026-09-10（fix/dsml-namespace-optional + fix/dsml-no-silent-leak）：用户 v0.1.97 现场 replySample
// ——DSML 块的命名空间被整体剥离，只剩裸标签。两个缺陷叠在一起：
//   ① 识别依赖 ｜DSML｜ → hasDsmlToolTags=false → 判「模型没调工具」→ 静默 stop；
//   ② 归一化失败时 fail-open 把块原文当正文发给下游，而流式路径没有 repair。
// 本用例锁两层：裸形态必须直接解析；解析不出时必须 repair（而不是静默透传）。
describe('流式：命名空间被剥离的 DSML（现场 replySample 形态）', () => {
  const READ = 'Read';
  const TOOL = [{ type: 'function' as const, function: { name: READ, description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const bare = (tag: string, attrs = ''): string => `<${tag}${attrs}>`;
  /** 现场形态：三个字段全部不带命名空间（sketch.ino / diagram.json / libraries.txt 各一 invoke）。 */
  const FIELD =
    `${bare('tool_calls')}\n` +
    `${bare('invoke', ` name="${READ}"`)}\n` +
    `${bare('parameter', ' name="path" string="true"')}sketch.ino</parameter>\n` +
    `</invoke>\n` +
    `${bare('invoke', ` name="${READ}"`)}\n` +
    `${bare('parameter', ' name="path" string="true"')}diagram.json</parameter>\n` +
    `</invoke>\n` +
    `</tool_calls>`;
  /** 有 invoke 标记但结构残缺（`</invoke>` 缺失）→ 归一化必然失败，用来驱动 repair 分支。 */
  const BROKEN =
    `${bare('tool_calls')}\n` +
    `${bare('invoke', ` name="${READ}"`)}\n` +
    `${bare('parameter', ' name="path" string="true"')}broken.ino</parameter>\n` +
    `</tool_calls>`;
  const REPAIRED = `<tool_calls>[{"id":"c1","type":"function","function":{"name":"${READ}","arguments":"{\\"path\\":\\"sketch.ino\\"}"}}]</tool_calls>`;

  interface Drained { content: string; names: string[]; finish: string | null; error?: string }
  async function drain(iterable: AsyncIterable<unknown>): Promise<Drained> {
    const out: Drained = { content: '', names: [], finish: null };
    try {
      for await (const c of iterable as AsyncIterable<any>) {
        const d = c?.choices?.[0]?.delta ?? {};
        if (typeof d.content === 'string') out.content += d.content;
        for (const tc of d.tool_calls ?? []) if (tc?.function?.name) out.names.push(tc.function.name);
        const fr = c?.choices?.[0]?.finish_reason;
        if (fr) out.finish = fr;
      }
    } catch (e) { out.error = (e as Error).message; }
    return out;
  }

  /** 第 1 次 streamCompletion 返 first，repair 重问（第 2 次）返 second。calls() 读调用次数。 */
  function adapter(first: string, second: string) {
    let n = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        n += 1;
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: n === 1 ? first : second };
      },
    });
    return { a, calls: () => n };
  }

  it('fail-to-pass：裸形态直接解析成 tool_calls，content 不含裸标记，且不触发 repair', async () => {
    const { a, calls } = adapter(FIELD, REPAIRED);
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'bare-cid' });
    const res = await drain(s as AsyncIterable<unknown>);
    expect(res.error).toBeUndefined();
    expect(res.content).not.toContain(` name="`);
    expect(res.content).toContain('<tool_calls>');
    expect(res.names).toEqual([READ, READ]);
    expect(res.finish).toBe('tool_calls');
    expect(calls()).toBe(1);   // 一次调用就解析成功，没走 repair
    const asst = (r as any).d.mapper.threads.get('deepseek:bare-cid').mirror.at(-1)!;
    expect(asst.content).not.toContain(` name="`);
    expect(asst.tool_calls).toHaveLength(2);
  });

  it('fail-to-pass：归一化失败 → repair 一次成功，仍产出 tool_calls 且不泄漏原文', async () => {
    const { a, calls } = adapter(BROKEN, REPAIRED);
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'repair-ok-cid' });
    const res = await drain(s as AsyncIterable<unknown>);
    expect(res.error).toBeUndefined();
    expect(res.content).not.toContain('broken.ino');   // 解析不出的块绝不透传给下游
    expect(res.names).toEqual([READ]);
    expect(res.finish).toBe('tool_calls');
    expect(calls()).toBe(2);                           // 恰好 repair 一次
  });

  it('fail-to-pass：repair 仍失败 → 抛 400（对齐非流式 finalize），不静默透传原文', async () => {
    const { a, calls } = adapter(BROKEN, '我还是不会');
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'repair-fail-cid' });
    const res = await drain(s as AsyncIterable<unknown>);
    expect(res.error).toBeTruthy();
    expect(res.error).toContain('tool call parse failed');
    expect(res.content).not.toContain('broken.ino');
    expect(res.finish).toBeNull();
    expect(calls()).toBe(2);
  });
});

// 2026-09-10（feat/log-b64-export）：现场取证通道。用户贴回的日志里 ｜DSML｜ 会被粘贴链吃掉，
// 造成“无法判断字节形态”无法收敛。日志同时带 base64 版本（纯 ASCII，可无损跨粘贴链）。
// 本用例锁最需要证据的那条路径：工具解析**失败**（400）时仍要能取回模型原文。
describe('日志字节取证（feat/log-b64-export）', () => {
  const READ = 'Read';
  const I = 'inv' + 'oke', N = 'na' + 'me', P = 'para' + 'meter', S = 'str' + 'ing';
  const TOOL = [{ type: 'function' as const, function: { name: READ, description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const bare = (tag: string, attrs = ''): string => `<${tag}${attrs}>`;
  const BROKEN =
    `${bare('tool_calls')}\n` +
    `${bare(I, ` ${N}="${READ}"`)}\n` +
    `${bare(P, ` ${N}="path" ${S}="true"`)}broken.ino</${P}>\n` +
    `</tool_calls>`;

  it('fail-to-pass：工具解析失败（400）时，rawB64 仍能无损还原带标记的模型原文', async () => {
    let n = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        n += 1;
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: n === 1 ? BROKEN : '我还是不会' };
      },
    });
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', '描述项目')], tools: TOOL, stream: true, conversation_id: 'b64-cid' });
    try { for await (const _c of s as AsyncIterable<unknown>) { void _c; } } catch { /* 期望 400 */ }

    const e = r['d'].log.list().at(-1)! as any;
    expect(e.ok).toBe(false);
    expect(e.version).toBe('0.0.0-test');   // 自证构建版本：用户是否 reload 过一眼可辨
    expect(typeof e.rawB64).toBe('string');
    const raw = Buffer.from(e.rawB64, 'base64').toString('utf8');
    expect(raw).toContain(`${I} ${N}=`);    // 标记字节被完整带出来（不经粘贴链）
    expect(raw).toContain('broken.ino');
    // fail-closed：标记没被当正文透传给下游
    expect(e.replyB64).toBeUndefined();
  });
});

// 2026-09-11（fix/incomplete-stream-error）：真实事故——DeepSeek 服务端中途报错
// （{"type":"error","finish_reason":"generation_err"} + response/status=INCOMPLETE），
// 旧实现把它当流正常结束 → finish_reason='stop' + ok=true + 空回复（silent bug）。
// 修：parser 发 stream_error 事件 → Router 记录后于流末抛 503 provider_unavailable。
describe('incomplete stream / server error（fix/incomplete-stream-error）', () => {
  const errEvent = { kind: 'stream_error', message: 'Server is temporarily unavailable.', reason: 'generation_err' } as any;

  it('fail-to-pass：非流式 stream_error → 503 provider_unavailable（不再静默 stop）', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'think_delta', content: '想了' };
        yield errEvent;
      },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] }))
      .rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable', message: 'Server is temporarily unavailable.' } } });
  });

  it('fail-to-pass：stream:true 路径 stream_error → 已发分块后再抛 503', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: '前半' };
        yield errEvent;
      },
    });
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')], stream: true });
    const got: any[] = [];
    let caught: any;
    try { for await (const c of s as AsyncIterable<any>) got.push(c); } catch (e) { caught = e; }
    expect(got.length).toBeGreaterThan(0);   // 前半已发出的分块不回滚
    expect(caught).toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
  });

  it('regression：正常流（无 stream_error）仍以 stop 收尾', async () => {
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: '正常', finish_reason: 'stop' };
      },
    });
    const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.choices[0].message.content).toBe('正常');
  });
});
