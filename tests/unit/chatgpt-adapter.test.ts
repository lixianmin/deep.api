/**
 * ChatGPT provider adapter + bridge-client 测试。
 *
 * 覆盖范围（brief Step 1）：
 *   - adapter 契约：models 只暴露 `chatgpt-web` 单条目（模型由 ChatGPT 网页按账号套餐决定，
 *     扩展不提供选择）；resolveModel 只接受 `chatgpt-web`，旧的全量目录假 ID（gpt-5-5 / auto
 *     等）返回 null；
 *     streamCompletion 在收到 `frame` 后产出对应事件、收到 `done` 后结束；
 *     getAuthStatus 无桥接时返回 `logged_out`。
 *   - v1 范围守卫（brief 明确：必须报错不能静默忽略）：tools / vision / search。
 *   - reasoning override 例外：接受但忽略（2026-10-02 修复 debug 页 ChatGPT 每次必拒的 bug）——
 *     是否思考由 ChatGPT 网页侧决定，adapter 无通道可拒绝，只能忽略。
 *   - bridge-client 行为：消息路由、queue 串行、超时、断线。
 *
 * 设计决策（写下来备查）：
 *  - 测试只新建这一个文件（brief 约束）；bridge-client 与 adapter 紧耦合，bridge 的核心
 *    行为（queue 串行、超时、conversation_id 幂等）也放这里，避免散到多个文件。
 *  - adapter 通过 `ChatGPTBridge` 接口隔离 bridge-client；测试里用 async generator 模拟桥。
 *  - bridge-client 测试用最小 PortLike stub（不引入 chrome.*，便于纯单测）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChatGPTAdapter, type ChatGPTBridge, type ChatGPTAdapterDeps } from '../../src/background/providers/chatgpt/adapter';
import { createBridgeClient, type ChatGPTBridgeEvent, type ChatGPTPortLike } from '../../src/background/providers/chatgpt/bridge-client';
import type { ProviderCompletion, ProviderContext } from '../../src/background/providers/adapter';
import type { Message } from '../../src/shared/api-types';

// ===== 通用 mock 工具 =====

/** 最小 chrome.runtime.Port 替身：让 bridge-client 单测不依赖 chrome 全局。 */
interface FakePort {
  p: ChatGPTPortLike;
  sent: unknown[];
  deliver: (m: unknown) => void;
  disconnect: () => void;
}
function mkPort(): FakePort {
  const sent: unknown[] = [];
  let onMsg: ((m: unknown) => void) | null = null;
  let onDis: (() => void) | null = null;
  const p: ChatGPTPortLike = {
    postMessage: (m: unknown) => { sent.push(m); },
    onMessage: (cb) => { onMsg = cb; },
    onDisconnect: (cb) => { onDis = cb; },
  };
  return {
    p,
    sent,
    deliver: (m: unknown) => { if (onMsg) onMsg(m); },
    disconnect: () => { if (onDis) onDis(); },
  };
}

/** adapter 用的 bridge mock：默认是「无连接、request 直接抛」。 */
function mkBridge(over: Partial<ChatGPTBridge> = {}): ChatGPTBridge {
  return {
    hasConnection: () => false,
    request: makeRequestReturning([]),
    ...over,
  };
}

/** 从定事件序列构造一个 ChatGPTBridge.request 的 stub。 */
function makeRequestReturning(events: ChatGPTBridgeEvent[]): ChatGPTBridge['request'] {
  return ((_opts): AsyncIterable<ChatGPTBridgeEvent> => {
    void _opts;
    return (async function* () { for (const e of events) yield e; })();
  });
}

/** adapter 单测用的固定 ctx + 默认 req。 */
const mkCtx = (): ProviderContext => ({ token: '', requestId: 'req-test-001' });
const mkReq = (over: Partial<ProviderCompletion> = {}): ProviderCompletion => ({
  session: { providerId: 'chatgpt', webSessionId: '', parentMessageId: null },
  prompt: '你好',
  // ProviderCompletion.model 只有 { variant, thinking }；modelId 在 router 那层单独走 resolveModel。
  model: { variant: 'chatgpt-web', thinking: false },
  requestId: 'req-test-001',
  ...over,
});
const mkDeps = (over: Partial<ChatGPTAdapterDeps> = {}): ChatGPTAdapterDeps => ({
  bridge: mkBridge(),
  now: () => 0,
  ...over,
});

/** 把 AsyncIterable 摊平成数组（错误不抛，返回数组）。 */
async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

// ===== 1. models 与 resolveModel（brief Step 1 第一条）=====
describe('ChatGPTAdapter.models / resolveModel', () => {
  it('id 是 chatgpt', () => {
    const a = createChatGPTAdapter(mkDeps());
    expect(a.id).toBe('chatgpt');
  });

  it('loginPageUrl 指向 chatgpt.com', () => {
    const a = createChatGPTAdapter(mkDeps());
    expect(a.auth.loginPageUrl).toBe('https://chatgpt.com/');
  });

  // 回归断言：曾经暴露 6 个来自 /backend-api/models 全量目录的 ID（gpt-5-5 / auto 等），
  // 但模型名从不上游（页面自己写死 request body 的 model 字段），且全量目录与用户套餐无关——
  // 给出的是一排不生效的假选项。只留一个 chatgpt-web。
  it('models 只暴露 chatgpt-web 一个条目', () => {
    const a = createChatGPTAdapter(mkDeps());
    const ids = a.models.map((m) => m.id);
    expect(ids).toEqual(['chatgpt-web']);
    for (const m of a.models) {
      expect(m.provider).toBe('chatgpt');
      expect(typeof m.description).toBe('string');
    }
  });

  it('resolveModel 接受 chatgpt-web', () => {
    const a = createChatGPTAdapter(mkDeps());
    const r = a.resolveModel('chatgpt-web');
    expect(r).not.toBeNull();
    expect(r?.modelId).toBe('chatgpt-web');
    // v1 范围内：ChatGPT 模型不支持图片/思考（v1 范围守卫见下文）
    expect(r?.supportsImages).toBe(false);
    expect(r?.thinking).toBe(false);
    // variant 是占位符——桥接不上送模型名，真实模型由 ChatGPT 网页按账号套餐决定
    expect(r?.variant).toBe('chatgpt-web');
    // limitChars 不限制（v1 范围内 prompt 直接进 composer，不在 SW 端做长度校验）
    expect(typeof r?.limitChars).toBe('number');
  });

  // 回归断言：旧的 6 个假 ID 现在必须返回 null，防止以后又把它们加回来。
  it('resolveModel 拒绝旧的假 ID（gpt-5-* / auto 不再可选）', () => {
    const a = createChatGPTAdapter(mkDeps());
    for (const id of ['gpt-5-5', 'gpt-5-6', 'gpt-5-3-mini', 'gpt-5-5-mini', 'gpt-5-6-mini', 'auto']) {
      expect(a.resolveModel(id)).toBeNull();
    }
  });

  it('resolveModel 拒绝未知模型（含 deepseek-*，绝不串台）', () => {
    const a = createChatGPTAdapter(mkDeps());
    expect(a.resolveModel('gpt-unknown')).toBeNull();
    expect(a.resolveModel('gpt-4')).toBeNull();
    expect(a.resolveModel('deepseek-flash')).toBeNull();
    expect(a.resolveModel('')).toBeNull();
  });
});

// ===== 2. getAuthStatus：基于桥接连接 =====
describe('ChatGPTAdapter.auth.getAuthStatus', () => {
  it('无桥接（hasConnection=false）→ logged_out', async () => {
    const a = createChatGPTAdapter(mkDeps({ bridge: mkBridge({ hasConnection: () => false }) }));
    expect(await a.auth.getAuthStatus(mkCtx())).toEqual({ state: 'logged_out' });
  });

  it('有桥接（hasConnection=true）→ logged_in（用户在浏览器里登录了 chatgpt.com）', async () => {
    const a = createChatGPTAdapter(mkDeps({ bridge: mkBridge({ hasConnection: () => true }) }));
    expect(await a.auth.getAuthStatus(mkCtx())).toEqual({ state: 'logged_in' });
  });
});

// ===== 3. v1 范围守卫（brief 铁律：必须报错不能静默忽略）=====
describe('ChatGPTAdapter.streamCompletion v1 范围守卫', () => {
  it('tools 非空 → 抛 400 invalid_request_error，明确说明 v1 不支持', async () => {
    const a = createChatGPTAdapter(mkDeps());
    const req = mkReq({ tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }] });
    let err: unknown = null;
    try { for await (const _ of a.streamCompletion(mkCtx(), req)) void _; } catch (e) { err = e; }
    expect(err).toMatchObject({
      status: 400,
      error: { error: { code: 'invalid_request_error' } },
    });
    expect((err as { error: { error: { message: string } } }).error.error.message).toMatch(/v1.*不支持|不支持.*v1|tool/i);
  });

  it('messages 含 image_url 块 → 抛 400 invalid_request_error', async () => {
    const a = createChatGPTAdapter(mkDeps());
    const messages: Message[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KG' } }] }];
    const req = mkReq({ messages });
    let err: unknown = null;
    try { for await (const _ of a.streamCompletion(mkCtx(), req)) void _; } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
    expect((err as { error: { error: { message: string } } }).error.error.message).toMatch(/v1.*不支持|不支持.*v1|image|vision/i);
  });

  // 2026-10-02（fix/chatgpt-v1-guard-reasoning）：这条断言的方向从「抛 400」改成「不抛错」。
  // 原守卫让 debug 页选 ChatGPT 模型时每次都失败（reasoning 下拉默认 high 且每次都带上）。
  // 改为接受但忽略：思考与否由 ChatGPT 网页侧自主决定，adapter 根本没有可拒绝的通道。
  it('overrides.reasoning 非 undefined → 不抛错（接受但忽略），正常走完流', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => true,
      request: (() => {
        requestCalled = true;
        return makeRequestReturning([
          { kind: 'frame', event: null, data: '{"type":"message_marker","marker":"final_channel_token","event":"first"}' },
          { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"x"}' },
          { kind: 'done' },
        ]);
      })(),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const req = mkReq({ overrides: { reasoning: 'high' } });
    const events = await toArray(a.streamCompletion(mkCtx(), req));
    expect(requestCalled).toBe(true);
    expect(events.some((e) => e.kind === 'content_delta')).toBe(true);
  });

  it('overrides.reasoning=\'off\' → 同样不抛错（接受但忽略）', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => true,
      request: (() => {
        requestCalled = true;
        return makeRequestReturning([{ kind: 'done' }]);
      })(),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const req = mkReq({ overrides: { reasoning: 'off' } });
    await toArray(a.streamCompletion(mkCtx(), req));
    expect(requestCalled).toBe(true);
  });

  it('overrides.search=true → 抛 400（v1 不支持搜索）', async () => {
    const a = createChatGPTAdapter(mkDeps());
    const req = mkReq({ overrides: { search: true } });
    let err: unknown = null;
    try { for await (const _ of a.streamCompletion(mkCtx(), req)) void _; } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 400, error: { error: { code: 'invalid_request_error' } } });
    expect((err as { error: { error: { message: string } } }).error.error.message).toMatch(/v1.*不支持|不支持.*v1|search/i);
  });

  it('overrides.reasoning=undefined 且 search=undefined → 不报（沿用空），进入正常流', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => true,
      request: (() => {
        requestCalled = true;
        return makeRequestReturning([
          // 先发 final_channel_token 切到 content 通道，避免 think_delta 干扰断言
          { kind: 'frame', event: null, data: '{"type":"message_marker","marker":"final_channel_token","event":"first"}' },
          { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"x"}' },
          { kind: 'done' },
        ]);
      })(),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(requestCalled).toBe(true);
    expect(events.some((e) => e.kind === 'content_delta')).toBe(true);
  });
});

// ===== 4. streamCompletion：桥事件 → ProviderStreamEvent =====
describe('ChatGPTAdapter.streamCompletion 事件翻译', () => {
  it('frame + done → content_delta 后迭代器自然结束', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"你好"}' },
        { kind: 'done' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    // 命中正文 append（phase=reasoning 初值）→ think_delta（v1 范围未自定义 reasoning 时
    // 不强制切到 content；实测 final_channel_token 来了 adapter 的 frame 阶段会切到 content_delta，
    // 但本帧在切通道前到达 → think_delta 是预期结果）。
    expect(events).toContainEqual({ kind: 'think_delta', content: '你好' });
  });

  it('frame 在切通道后 → content_delta', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        // 先发 final_channel_token（adapter 不直接处理这个 kind——它由 stream.ts 在每个 frame 解释时切通道）
        { kind: 'frame', event: null, data: '{"type":"message_marker","marker":"final_channel_token","event":"first"}' },
        { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"世界"}' },
        { kind: 'done' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(events).toContainEqual({ kind: 'content_delta', content: '世界' });
  });

  it('error 帧 → stream_error 事件', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        { kind: 'frame', event: 'delta', data: '{"type":"error","content":"oops","finish_reason":"generation_err"}' },
        { kind: 'done' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    const e = events.find((x) => x.kind === 'stream_error');
    expect(e).toBeDefined();
    expect((e as { message: string }).message).toBe('oops');
  });

  it('bridge 顶层 error（kind=error）→ 直接产 stream_error 事件', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        { kind: 'error', message: 'chatgpt tab gone' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(events.some((e) => e.kind === 'stream_error' && (e as { message: string }).message === 'chatgpt tab gone')).toBe(true);
  });

  it('stream-start 不产事件（consumer 不需要这个信号）', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        { kind: 'stream-start' },
        { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"hi"}' },
        { kind: 'done' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    // stream-start 不在 ProviderStreamEvent 里——它就是个开关信号，不应作为事件发出
    expect(events.some((e) => (e as { kind: string }).kind === 'stream_start' || (e as { kind: string }).kind === 'stream-start')).toBe(false);
    expect(events.some((e) => e.kind === 'content_delta' || e.kind === 'think_delta')).toBe(true);
  });

  it('conversation 事件：更新 session.webSessionId 为新 conversation_id', async () => {
    const fakeBridge = mkBridge({
      request: makeRequestReturning([
        { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"x"}' },
        { kind: 'conversation', conversationId: 'conv-new-123' },
        { kind: 'done' },
      ]),
    });
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const req = mkReq();   // session.webSessionId = '' 起步
    await toArray(a.streamCompletion(mkCtx(), req));
    expect(req.session.webSessionId).toBe('conv-new-123');
  });

  it('把 prompt 传给 bridge.request；session.webSessionId 作为 conversationId（可能为空）', async () => {
    const captured: { text: string; conversationId: string | null } = { text: '', conversationId: 'unset' };
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => true,
      request: ((opts): AsyncIterable<ChatGPTBridgeEvent> => {
        captured.text = opts.text;
        captured.conversationId = opts.conversationId;
        return (async function* () { yield { kind: 'done' }; })();
      }),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    await toArray(a.streamCompletion(mkCtx(), mkReq({ prompt: '特定 prompt', session: { providerId: 'chatgpt', webSessionId: 'old-conv', parentMessageId: null } })));
    expect(captured.text).toBe('特定 prompt');
    expect(captured.conversationId).toBe('old-conv');
  });

  it('error 分类：unavailable=false / authExpired=false / rateLimited=false（ChatGPT 不在 SW 端分类）', () => {
    const a = createChatGPTAdapter(mkDeps());
    expect(a.isUnavailable(new Error('x'))).toBe(false);
    expect(a.isAuthExpired(new Error('x'))).toBe(false);
    expect(a.isRateLimited(new Error('x'))).toBe(false);
  });
});

// ===== 5. bridge-client 行为：消息路由、queue 串行、超时、断线 =====
describe('bridge-client', () => {
  let now: number;
  beforeEach(() => {
    now = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasConnection: 无 port → false', async () => {
    const bc = createBridgeClient({ now: () => now });
    expect(bc.hasConnection()).toBe(false);
  });

  it('hasConnection: 注册一个活 port → true', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    expect(bc.hasConnection()).toBe(true);
  });

  it('hasConnection: port 断开 → false', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    port.disconnect();
    expect(bc.hasConnection()).toBe(false);
  });

  it('无连接时 request 抛错（logged_out 等价语义）', async () => {
    const bc = createBridgeClient({ now: () => now });
    let err: unknown = null;
    try { for await (const _ of bc.request({ requestId: 'r1', text: 'hi', conversationId: null })) void _; } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/no chatgpt tab connected|未连接|logged_out/i);
  });

  it('正常流：send 发出 → 收 stream-start / frame / done → 产出三个事件后迭代器结束', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    // 触发 send（lazy iterator 需要 start()）
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    // send 消息已发出
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ __deepApiChatGPT: true, kind: 'send', requestId: 'r1', text: 'hi', conversationId: null });
    // 模拟 MAIN world 回包
    port.deliver({ __deepApiChatGPT: true, kind: 'stream-start', requestId: 'r1' });
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"x":1}' });
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['stream-start', 'frame', 'done']);
  });

  it('过滤非 __deepApiChatGPT 的杂音（页面其它脚本 postMessage 的噪音）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    // 噪音
    port.deliver({ __deepApi: { id: 1, kind: 'done' } });
    port.deliver({ kind: 'random' });
    port.deliver(null);
    port.deliver(123);
    // 正常包
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['done']);
  });

  it('queue 串行：第二个 request 等第一个完成才发 send', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    expect(port.sent).toHaveLength(1);
    // 第一个还在飞——发第二个（同一个 port，但单飞）
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    expect(port.sent).toHaveLength(1);   // 还没发第二个 send
    // 第一个 done 后，第二个 send 自动发出
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    await collectAll(it1);
    // pump 下一个
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ requestId: 'r2', text: 'B' });
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    await collectAll(it2);
  });

  it('超时：默认 120s 内无 done/error → 产 error 事件 + 主动结束', async () => {
    const bc = createBridgeClient({ now: () => now, defaultTimeoutMs: 100 });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    // 推一帧进度但不结束
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"x":1}' });
    const consumePromise = (async () => {
      const events: ChatGPTBridgeEvent[] = [];
      for await (const e of iter) {
        events.push(e);
        if (e.kind === 'done' || e.kind === 'error') break;
      }
      return events;
    })();
    // 推进超时
    await vi.advanceTimersByTimeAsync(110);
    const events = await consumePromise;
    const lastErr = [...events].reverse().find((e) => e.kind === 'error');
    expect(lastErr).toBeDefined();
    expect((lastErr as { message: string }).message).toMatch(/timeout/i);
  });

  it('超时后 pending 表移除：后续 request 能正常开始', async () => {
    const bc = createBridgeClient({ now: () => now, defaultTimeoutMs: 100 });
    const port = mkPort();
    bc.registerPort(port.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    await vi.advanceTimersByTimeAsync(150);
    await collectAll(it1);
    // 第一个超时了 → 第二个能正常发
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    expect(port.sent.map((m) => (m as { requestId?: string }).requestId)).toEqual(['r1', 'r2']);
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    await collectAll(it2);
  });

  it('port 断开：在飞 request 立即产 error + 后续 request 拒绝（无连接）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    port.disconnect();
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    // 后续 request 应抛 logged_out
    let err: unknown = null;
    try { for await (const _ of bc.request({ requestId: 'r2', text: 'x', conversationId: null })) void _; } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/no chatgpt tab connected|logged_out/i);
  });

  it('conversation 重复上报不丢消息：同一 requestId 来两次 conversation → 都产出 + 都携同 id（bridge 不实现去重，consumer 自己处理幂等）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    port.deliver({ __deepApiChatGPT: true, kind: 'conversation', requestId: 'r1', conversationId: 'conv-X' });
    port.deliver({ __deepApiChatGPT: true, kind: 'conversation', requestId: 'r1', conversationId: 'conv-X' });
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"x":1}' });
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    // 两条 conversation 都携同 conversationId；bridge 不去重——consumer 上层处理。
    const convEvents = events.filter((e): e is { kind: 'conversation'; conversationId: string } => e.kind === 'conversation');
    expect(convEvents.length).toBe(2);
    expect(convEvents.every((e) => e.conversationId === 'conv-X')).toBe(true);
  });

  it('callerside iterator 提前 break：清理内部 timer，不得泄漏', async () => {
    const bc = createBridgeClient({ now: () => now, defaultTimeoutMs: 1000 });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    // 记录发送数：调用 iter.return() 前仅 1 个 send 发出（仅 r1）
    expect(port.sent).toHaveLength(1);
    // 立即断开（不消费）——iter.return 收尾
    expect(iter.return).toBeDefined();
    if (iter.return) {
      const r = await iter.return();
      // return 告诉 consumer 不会再产事件了
      expect(r.done).toBe(true);
    }
    // 推进时间：若 timer 没清，到 1000ms 会进 timer → 产 error 事件→ 错位。
    // 检查这个连点：fake timer 推进过超时点，但不应有任何 timeout error 出现。
    await vi.advanceTimersByTimeAsync(2000);
    // 实际断言：iter.return 后 active 被释放，后续 request 能正常发送（意味着 timer 已清、active 已重置）
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    expect(port.sent.map((m) => (m as { requestId?: string }).requestId)).toEqual(['r1', 'r2']);
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    await collectAll(it2);
  });

  it('timeoutMs≤0 → 抛错（参数校验）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    let err: unknown = null;
    try { for await (const _ of bc.request({ requestId: 'r1', text: 'A', conversationId: null, timeoutMs: 0 })) void _; } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/timeout/i);
  });

  // 2026-10-01（fix/bridge-stale-frames）：dispatchIncoming 必须按 requestId 过滤。旧实现忽略
  // msg.requestId —— r1 超时释放后，tap 仍在读流；后续投递给 r1 的 frame/done 会被当成 r2 的内容
  // 注入 active，导致 r2 的回复被截断并当作正常结束。
  it('r1 超时后投递一个 r1 的 frame：断言不进 r2 的迭代器（requestId 过滤）', async () => {
    const bc = createBridgeClient({ now: () => now, defaultTimeoutMs: 100 });
    const port = mkPort();
    bc.registerPort(port.p);
    // r1 启动，不消费
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    // 推点内容，但不结束
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"r1-part"}' });
    // 超时 → r1 释放 active
    await vi.advanceTimersByTimeAsync(150);
    await collectAll(it1);

    // r2 启动并消费（观察 buffer 内容）
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    // r2 自己的 frame（应当收到）
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r2', event: 'delta', data: '{"v":"r2-part"}' });
    // 关键：现在又来一个 r1 的残留 frame（tap 还在读 → 投递）——必须被忽略
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"STALE-r1"}' });
    // 关键：r1 的 done 也必须被忽略
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    // r2 真正的 done
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });

    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of it2) events.push(e);
    // r2 只收到自己的 frame + done；r1 的任何东西都不该出现
    expect(events.map((e) => e.kind)).toEqual(['frame', 'done']);
    const frame = events.find((e) => e.kind === 'frame');
    if (frame && frame.kind === 'frame') expect(frame.data).toBe('{"v":"r2-part"}');
  });

  it('仅在 active 的 requestId 与消息匹配时才消费；消息/requestId 缺失时仍走原路径（退化兼容）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    // 缺 requestId 字段的帧（兼容旧实现 / 测试 stub）：当作 active 自己的消息（不漏丢）
    port.deliver({ __deepApiChatGPT: true, kind: 'frame', event: 'delta', data: '{"v":"legacy"}' });
    port.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of it1) events.push(e);
    // 两条都在（兼容旧 MAIN world 输出）
    expect(events.map((e) => e.kind)).toEqual(['frame', 'done']);
  });
});

/** 把 iterator 消费完（不保留结果）。 */
async function collectAll(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) void _;
}