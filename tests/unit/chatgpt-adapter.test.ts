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
 *   - bridge-client 行为：消息路由、queue 串行、超时、断线、导航交接（port 断开后由新 port 接管）。
 *
 * 设计决策（写下来备查）：
 *  - 测试只新建这一个文件（brief 约束）；bridge-client 与 adapter 紧耦合，bridge 的核心
 *    行为（queue 串行、超时、conversation_id 幂等）也放这里，避免散到多个文件。
 *  - adapter 通过 `ChatGPTBridge` 接口隔离 bridge-client；测试里用 async generator 模拟桥。
 *  - bridge-client 测试用最小 PortLike stub（不引入 chrome.*，便于纯单测）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChatGPTAdapter, type ChatGPTBridge, type ChatGPTAdapterDeps } from '../../src/background/providers/chatgpt/adapter';
import { createBridgeClient, REATTACH_TIMEOUT_MS, type ChatGPTBridgeEvent, type ChatGPTPortLike } from '../../src/background/providers/chatgpt/bridge-client';
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

/**
 * 已死但 onDisconnect 还没派发的 port：postMessage 立刻抛错（走 pumpQueue 的 catch 分支）。
 * 对应「标签页正在导航、旧上下文已销毁」的窗口。
 */
function mkDeadPort(): ChatGPTPortLike {
  return {
    postMessage: () => { throw new Error('Attempting to use a disconnected port object'); },
    onMessage: () => { /* 死 port 不会再来消息 */ },
    onDisconnect: () => { /* 本用例只测 postMessage 抛错这条路径 */ },
  };
}

/** adapter 用的 bridge mock：默认是「无连接、ensureReady 空转、request 直接抛」。 */
function mkBridge(over: Partial<ChatGPTBridge> = {}): ChatGPTBridge {
  return {
    hasConnection: () => false,
    ensureReady: async () => {},
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
      ensureReady: async () => {},
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
      ensureReady: async () => {},
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
      ensureReady: async () => {},
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
// 2026-10-03（fix/chatgpt-no-tab-clear-error）：用户没打开 chatgpt.com 标签页时，
// bridge.request 抛的 Error 会经 router 的 mapErrStatic 归成 500 internal_error——
// 三个分类器全 false，用户看不到任何可行动信息。改为在 adapter 里提前判连接并 yield
// stream_error（router 把它转成 503 provider_unavailable 并把 message 透给用户）。
describe('ChatGPTAdapter.streamCompletion 无桥接连接', () => {
  it('hasConnection()=false → 恰好产一条 stream_error，且完全不调 bridge.request', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => false,
      ensureReady: async () => {},
      request: ((_opts) => { requestCalled = true; return makeRequestReturning([{ kind: 'done' }])(_opts); }),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(requestCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('stream_error');
  });

  it('无连接提示可行动：包含 chatgpt.com / 打开 / 保持标签页打开的引导', async () => {
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => false,
      ensureReady: async () => {},
      request: makeRequestReturning([{ kind: 'done' }]),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    const message = (events[0] as { message: string } | undefined)?.message ?? '';
    expect(message).toMatch(/chatgpt\.com/);
    expect(message).toMatch(/打开/);
    // 关键引导：标签页关掉桥就断了——只说「打开」不够
    expect(message).toMatch(/标签页/);
    expect(message).toMatch(/保持|不要关闭|别关/);
  });

  it('防回归：hasConnection()=true → 走原有路径（调 bridge.request，不产 stream_error）', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => true,
      ensureReady: async () => {},
      request: (() => {
        requestCalled = true;
        return makeRequestReturning([
          { kind: 'frame', event: null, data: '{"type":"message_marker","marker":"final_channel_token","event":"first"}' },
          { kind: 'frame', event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"hi"}' },
          { kind: 'done' },
        ]);
      })(),
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(requestCalled).toBe(true);
    expect(events.some((e) => e.kind === 'stream_error')).toBe(false);
    expect(events.some((e) => e.kind === 'content_delta' && e.content === 'hi')).toBe(true);
  });
});

describe('ChatGPTAdapter.streamCompletion 事件翻译', () => {
  it('frame + done → content_delta 后迭代器自然结束', async () => {
    const fakeBridge = mkBridge({
      hasConnection: () => true,
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
      hasConnection: () => true,
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
      hasConnection: () => true,
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
      hasConnection: () => true,
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
      hasConnection: () => true,
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
      hasConnection: () => true,
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
      ensureReady: async () => {},
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

// ===== 4b. ensureReady：先把扩展自己的标签页准备好，再判连接 =====
// 2026-10-04（fix/chatgpt-owned-tab）：旧实现要求用户自己开 chatgpt.com 标签页并保持它开着，
// 还要复用那个标签页——用户可能正在里面手动操作。改为扩展独占一个标签页：请求前先
// ensureReady（开/复用专属 tab + 等 relay 连上），连不上才报可行动错。
describe('ChatGPTAdapter.streamCompletion ensureReady（扩展自己的标签页）', () => {
  it('先 await ensureReady 再判 hasConnection（顺序不能反：没 tab 时 hasConnection 必为 false）', async () => {
    const order: string[] = [];
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => { order.push('hasConnection'); return true; },
      ensureReady: async () => { order.push('ensureReady'); },
      request: () => { order.push('request'); return makeRequestReturning([{ kind: 'done' }])({ requestId: 'r1', text: 'hi', conversationId: null }); },
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(order).toEqual(['ensureReady', 'hasConnection', 'request']);
  });

  it('ensureReady 后仍无连接 → 恰好一条 stream_error，且完全不调 bridge.request', async () => {
    let requestCalled = false;
    let readyCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => false,
      ensureReady: async () => { readyCalled = true; },
      request: () => { requestCalled = true; return makeRequestReturning([{ kind: 'done' }])({ requestId: 'r1', text: 'hi', conversationId: null }); },
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(readyCalled).toBe(true);
    expect(requestCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('stream_error');
  });

  it('ensureReady 抛错（开不出标签页）→ 转成可行动 stream_error，不抛裸 Error（否则 500）', async () => {
    let requestCalled = false;
    const fakeBridge: ChatGPTBridge = {
      hasConnection: () => false,
      ensureReady: async () => { throw new Error('chrome.windows.create failed'); },
      request: () => { requestCalled = true; return makeRequestReturning([{ kind: 'done' }])({ requestId: 'r1', text: 'hi', conversationId: null }); },
    };
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    expect(requestCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('stream_error');
    expect((events[0] as { message: string }).message).toMatch(/标签页|窗口/);
  });

  it('无连接文案：说清是扩展自己的标签页 + 关掉会自动重建（不再让用户手动开）', async () => {
    const fakeBridge: ChatGPTBridge = mkBridge();
    const a = createChatGPTAdapter(mkDeps({ bridge: fakeBridge }));
    const events = await toArray(a.streamCompletion(mkCtx(), mkReq()));
    const message = (events[0] as { message: string } | undefined)?.message ?? '';
    expect(message).toMatch(/扩展/);
    expect(message).toMatch(/标签页/);
    expect(message).toMatch(/重建|重新/);
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

  // 2026-10-04（fix/chatgpt-nav-port-handoff）：断线语义从「立即判死」改为「先等重新接管」。
  // 本用例保留的是**真故障**那条路径（专属窗口被关、页面一直不恢复）：仍然报
  // 'chatgpt tab disconnected'，只是时点由「立即」改为 REATTACH_TIMEOUT_MS 之后。
  // 这是本次修复唯一动过期望值的既有断言（其余断言原样保留）。
  it('port 断开且无人接管：REATTACH_TIMEOUT_MS 后产 error + 后续 request 拒绝（无连接）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    const events: ChatGPTBridgeEvent[] = [];
    const consuming = (async () => { for await (const e of iter) events.push(e); })();
    port.disconnect();
    // 窗口内不判死（不产事件、不结束）
    await vi.advanceTimersByTimeAsync(REATTACH_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    // 窗口到期 → 仍是同一条错误文案
    await vi.advanceTimersByTimeAsync(10);
    await consuming;
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect((events[0] as { message: string }).message).toBe('chatgpt tab disconnected');
    // 后续 request 应抛 logged_out
    let err: unknown = null;
    try { for await (const _ of bc.request({ requestId: 'r2', text: 'x', conversationId: null })) void _; } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/no chatgpt tab connected|logged_out/i);
  });

  // ===== 2026-10-04（fix/chatgpt-nav-port-handoff）：导航交接不是故障 =====
  // 页面侧在 conversationId === null 且当前路径不是 '/'（标签页已被上一次请求带到 /c/<id>）时
  // 会 location.assign('/')（chatgpt-bridge-main.ts 的 decideSendNavigation）——旧文档销毁 →
  // content script 的 port 必然断开，而指令已存进 sessionStorage、新文档重注入后接着跑。
  // 旧实现把这个交接当致命断线，且 port 已死、error 事件发不出去 → 「第一次请求成功后，之后
  // 每次请求（新线程必触发导航）完全无响应」。以下用例锁定新语义：窗口内新 port 接管即续跑。

  it('导航交接成功：老 port 断开 → 窗口内新 port 接管 → 请求正常完成且无 error 事件', async () => {
    const bc = createBridgeClient({ now: () => now });
    const oldPort = mkPort();
    bc.registerPort(oldPort.p);
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    expect(oldPort.sent).toHaveLength(1);
    // 页面侧同源导航：旧文档销毁，老 port 断开
    oldPort.disconnect();
    // 导航 + 重注入约 1-4 秒，远早于接管窗口到期
    await vi.advanceTimersByTimeAsync(1_500);
    const newPort = mkPort();
    bc.registerPort(newPort.p);
    // 新文档按 sessionStorage 里的 pendingSend 继续跑，回帧带同一个 requestId
    newPort.deliver({ __deepApiChatGPT: true, kind: 'stream-start', requestId: 'r1' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'conversation', requestId: 'r1', conversationId: 'conv-1' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":1}' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
      if (e.kind === 'done' || e.kind === 'error') break;   // 同生产 consumer：break → return() 释放 active
    }
    expect(events.map((e) => e.kind)).toEqual(['stream-start', 'conversation', 'frame', 'done']);
    // 推进远超接管窗口：不得再有残留定时器产 error / 泄漏
    await vi.advanceTimersByTimeAsync(REATTACH_TIMEOUT_MS * 3);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('接管后新 port 的帧按 requestId 流入同一 active 请求；下一个请求也发到新 port', async () => {
    const bc = createBridgeClient({ now: () => now });
    const oldPort = mkPort();
    bc.registerPort(oldPort.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    oldPort.disconnect();
    const newPort = mkPort();
    bc.registerPort(newPort.p);
    newPort.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"from-new-port"}' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events1: ChatGPTBridgeEvent[] = [];
    for await (const e of it1) {
      events1.push(e);
      if (e.kind === 'done' || e.kind === 'error') break;   // 同生产 consumer：break → return() 释放 active
    }
    expect(events1.map((e) => e.kind)).toEqual(['frame', 'done']);
    expect((events1[0] as { data: string }).data).toBe('{"v":"from-new-port"}');
    // active.port 已指向新 port：后续请求的 send 不会写到那个死掉的老 port
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    expect(oldPort.sent).toHaveLength(1);   // 老 port 只有 r1（且此时已断开）
    expect(newPort.sent).toHaveLength(1);
    expect(newPort.sent[0]).toMatchObject({ kind: 'send', requestId: 'r2' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    await collectAll(it2);
  });

  it('接管后别的 requestId 的帧不得混入（requestId 过滤在交接后仍然生效）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const oldPort = mkPort();
    bc.registerPort(oldPort.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    oldPort.disconnect();
    const newPort = mkPort();
    bc.registerPort(newPort.p);
    // 老请求的残留回包（tap 仍在读）不得进 r1
    newPort.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r-stale', event: 'delta', data: '{"v":"STALE"}' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r-stale' });
    // 自己的帧必须进
    newPort.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"mine"}' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of it1) {
      events.push(e);
      if (e.kind === 'done' || e.kind === 'error') break;   // 同生产 consumer：break → return() 释放 active
    }
    expect(events.map((e) => e.kind)).toEqual(['frame', 'done']);
    expect((events[0] as { data: string }).data).toBe('{"v":"mine"}');
  });

  it('send 时 postMessage 抛错：同样走交接等待（不是立即判死），新 port 接管后正常完成', async () => {
    const bc = createBridgeClient({ now: () => now });
    bc.registerPort(mkDeadPort());
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });   // 此处 postMessage 抛错
    const events: ChatGPTBridgeEvent[] = [];
    const consuming = (async () => {
      for await (const e of iter) {
        events.push(e);
        if (e.kind === 'done' || e.kind === 'error') break;   // 同生产 consumer：break → return() 释放 active
      }
    })();
    // 窗口内没有 error（旧实现在 postMessage 抛错那一瞬就产 'chatgpt tab disconnected'）
    await vi.advanceTimersByTimeAsync(REATTACH_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    const fresh = mkPort();
    bc.registerPort(fresh.p);
    fresh.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    await consuming;
    expect(events.map((e) => e.kind)).toEqual(['done']);
    expect(vi.getTimerCount()).toBe(0);   // 接管定时器已清、总超时已随 done 释放
  });

  it('send 时 postMessage 抛错且无人接管：REATTACH_TIMEOUT_MS 后仍产 error（不永久 hang）', async () => {
    const bc = createBridgeClient({ now: () => now });
    bc.registerPort(mkDeadPort());
    const iter = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    const events: ChatGPTBridgeEvent[] = [];
    const consuming = (async () => { for await (const e of iter) events.push(e); })();
    await vi.advanceTimersByTimeAsync(REATTACH_TIMEOUT_MS + 1);
    await consuming;
    expect(events.map((e) => e.kind)).toEqual(['error']);
    expect((events[0] as { message: string }).message).toBe('chatgpt tab disconnected');
  });

  it('cancel（iter.return）清掉 reattachTimer：窗口过后不产事件，也不打扰下一个请求', async () => {
    const bc = createBridgeClient({ now: () => now });
    const oldPort = mkPort();
    bc.registerPort(oldPort.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    oldPort.disconnect();   // 进入「等待重新接管」
    await vi.advanceTimersByTimeAsync(1_000);
    expect(it1.return).toBeDefined();
    await it1.return?.();
    // 总超时 + 接管定时器都必须清掉（否则窗口到期时会误判/泄漏）
    expect(vi.getTimerCount()).toBe(0);
    // 推进远超窗口：没有残留定时器误产事件，后续请求照常
    const newPort = mkPort();
    bc.registerPort(newPort.p);
    const events: ChatGPTBridgeEvent[] = [];
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    await vi.advanceTimersByTimeAsync(REATTACH_TIMEOUT_MS * 3);
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    for await (const e of it2) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['done']);
  });

  it('已取消的请求不会被接管逻辑复活：迟到帧直接丢，也不重新起定时器', async () => {
    const bc = createBridgeClient({ now: () => now });
    const oldPort = mkPort();
    bc.registerPort(oldPort.p);
    const it1 = bc.request({ requestId: 'r1', text: 'A', conversationId: null });
    oldPort.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    await it1.return?.();
    expect(vi.getTimerCount()).toBe(0);
    const newPort = mkPort();
    bc.registerPort(newPort.p);
    // 已取消的 r1 的迟到帧：active 已空 → 直接丢（不会被「重新接管」捡起来）
    newPort.deliver({ __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"after-cancel"}' });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    expect(vi.getTimerCount()).toBe(0);   // 没有为死去的 r1 重新起定时器
    // 后续请求照常，且不携带 r1 的残帧
    const it2 = bc.request({ requestId: 'r2', text: 'B', conversationId: null });
    newPort.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r2' });
    const events: ChatGPTBridgeEvent[] = [];
    for await (const e of it2) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['done']);
  });

  it('没有在飞请求时的 port 断开：行为不变（只摘掉 port，不产事件、不留定时器）', async () => {
    const bc = createBridgeClient({ now: () => now });
    const port = mkPort();
    bc.registerPort(port.p);
    port.disconnect();
    expect(bc.hasConnection()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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

// ===== 6. 标签页归属（fix/chatgpt-owned-tab）：用户的标签页必须被无视 =====
// 核心回归：registerPort 旧实现接受任何 deepapi-chatgpt port，于是扩展会劫持用户自己
// 正在手动操作的 chatgpt.com 标签页（跳走当前会话、清 composer、插队到用户对话）。
// 现在每个 port 记 tabId，hasConnection / pickAlivePort 只认 tabId === ownedTabId 的那些。
describe('bridge-client 标签页归属（setOwnedTab）', () => {
  let now: number;
  beforeEach(() => { now = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('**核心回归**：ownedTab=1 时，用户标签页（tabId=2）的 port 算「无连接」', () => {
    const bc = createBridgeClient({ now: () => now });
    bc.setOwnedTab(1);
    const userTab = mkPort();
    bc.registerPort(userTab.p, 2);
    expect(bc.hasConnection()).toBe(false);
  });

  it('ownedTab=1 时，属于自己的 port（tabId=1）才算连接', () => {
    const bc = createBridgeClient({ now: () => now });
    bc.setOwnedTab(1);
    bc.registerPort(mkPort().p, 1);
    expect(bc.hasConnection()).toBe(true);
  });

  it('用户的 port 不只不算连接，还不会被发指令（send 绝不落到 tabId=2 的 port 上）', () => {
    const bc = createBridgeClient({ now: () => now });
    bc.setOwnedTab(1);
    const userTab = mkPort();
    bc.registerPort(userTab.p, 2);
    expect(bc.hasConnection()).toBe(false);
    expect(() => bc.request({ requestId: 'r1', text: 'hi', conversationId: null })).toThrow(/no chatgpt tab connected/);
    expect(userTab.sent).toHaveLength(0);
  });

  it('用户的 port 与自己的 port 同时在：只给自己的那一个发指令', async () => {
    vi.useFakeTimers();
    const bc = createBridgeClient({ now: () => now, defaultTimeoutMs: 120_000 });
    bc.setOwnedTab(1);
    const userTab = mkPort();
    const ownTab = mkPort();
    bc.registerPort(userTab.p, 2);
    bc.registerPort(ownTab.p, 1);
    const it = bc.request({ requestId: 'r1', text: 'hi', conversationId: null });
    expect(userTab.sent).toHaveLength(0);
    expect(ownTab.sent).toHaveLength(1);
    ownTab.deliver({ __deepApiChatGPT: true, kind: 'done', requestId: 'r1' });
    await collectAll(it);
  });

  it('尚未认领（ownedTab=null）时，带 tabId 的 port 一律不算连接（都是外部/用户标签页）', () => {
    const bc = createBridgeClient({ now: () => now });
    bc.registerPort(mkPort().p, 7);
    expect(bc.hasConnection()).toBe(false);
  });

  it('setOwnedTab(null) / 换 tab → 旧归属的 port 立即失效', () => {
    const bc = createBridgeClient({ now: () => now });
    bc.registerPort(mkPort().p, 1);
    bc.setOwnedTab(1);
    expect(bc.hasConnection()).toBe(true);
    bc.setOwnedTab(null);
    expect(bc.hasConnection()).toBe(false);
    bc.setOwnedTab(1);
    expect(bc.hasConnection()).toBe(true);
    bc.setOwnedTab(2);
    expect(bc.hasConnection()).toBe(false);
  });
});