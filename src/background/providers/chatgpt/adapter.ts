/**
 * ChatGPT provider adapter（实现 ProviderAdapter 接口）。
 *
 * 链路：Router → ChatGPTAdapter.streamCompletion → ChatGPTBridge → ISOLATED relay → MAIN world
 * 钩子 → chatgpt.com 页面 fetch → 流式 SSE → 旁路 tap → MAIN world postMessage → ISOLATED
 * relay → ChatGPTBridge → adapter 把 frame 喂给 ChatGPT stream 解释器 → ProviderStreamEvent。
 *
 * v1 范围（brief 铁律）：不支持 tool_calls / vision / search。
 * 收到这些参数必须抛 400 invalid_request_error 并说明「v1 不支持」——不能静默忽略
 * （静默会让 spice 等调用方误以为能力存在）。守卫位置在 streamCompletion 入口，过 gate
 * 失败即抛；bridge 不发。
 *
 * 例外：overrides.reasoning 接受但忽略（2026-10-02 fix/chatgpt-v1-guard-reasoning）。
 * 是否思考由 ChatGPT 网页侧自主决定，页面桥接没有任何可关闭思考流的通道——抛错并不能让
 * 调用方拿到「不思考」，只会让 ChatGPT 完全不可用（debug 页 reasoning 下拉默认 high，
 * 结果每次请求都失败）。tools/vision/search 仍拒：那是真实能力缺失，静默会让调用方
 * 以为能力存在而做出错误决策。
 *
 * 设计取舍（写下来备查）：
 *  - Bridge 用 PortLike 抽象 + ChatGPTBridge 接口隔离：adapter 只关心「桥事件序列」，
 *    不直接 import bridge-client 实现（保持测试可用纯 stub）。
 *  - 'conversation' 事件被 adapter 用来 mutate req.session.webSessionId——这是「让下一次
 *    incremental 请求能复用同一会话」的唯一手段（DeepSeek 走 parentMessageId 链；ChatGPT
 *    走 conversation_id，session.webSessionId 在 adapter 视角下就是 conversationId）。
 *  - 阶段初始为 'reasoning'（stream.ts 默认）；frame 经 stream.ts 解释 → content/think_delta，
 *    通道切换由 message_marker 帧触发（frame 内的 JSON 有 type=message_marker 的会被 stream.ts
 *    切到 'content'）。
 */
import type {
  AuthStatus,
  ProviderAdapter as IProviderAdapter,
  ProviderCompletion,
  ProviderContext,
  ProviderSession,
  ProviderStreamEvent,
  ResolvedModel,
} from '../adapter';
import type { ContentBlock, Message } from '../../../shared/api-types';
import { BridgeError } from '../../../shared/protocol';
import { MODELS, resolveModel } from './client';
import { CHATGPT_LOGIN_PAGE, getAuthStatus } from './auth';
import { newStreamState, interpretFrame } from './stream';
import type { ChatGPTStreamState } from './stream';
import type { ChatGPTBridgeEvent } from './bridge-client';

// ===== Bridge 接口（adapter 视角；测试用 stub）=====

/** adapter 用 bridge 的最小契约。bridge-client 实现 + 测试 stub 都满足。 */
export interface ChatGPTBridge {
  hasConnection(): boolean;
  /**
   * 请求前把「扩展自己的 chatgpt.com 标签页」准备好：不存在就开（独立窗口、不抢焦点），
   * 并等到它的 relay 连上。SW 侧注入的实现负责这件事，内含超时且不抛错——
   * 失败由 streamCompletion 紧接着的 hasConnection() 判断转成可行动错误。
   * 2026-10-04（fix/chatgpt-owned-tab）：以前是要用户自己开标签页并保持它开着，还会劫持它。
   */
  ensureReady(): Promise<void>;
  request(opts: {
    requestId: string;
    text: string;
    conversationId: string | null;
    timeoutMs?: number;
  }): AsyncIterable<ChatGPTBridgeEvent>;
}

export interface ChatGPTAdapterDeps {
  bridge: ChatGPTBridge;
  now(): number;
}

// ===== v1 守卫（错误构造）=====

function v1GuardError(message: string): BridgeError {
  // v1 范围铁律——必须显式 400 + invalid_request_error + 明确说明「v1 不支持」。
  // code 用 invalid_request_error：这是请求侧问题，不是 provider 服务问题。
  return new BridgeError(
    { error: { message: `v1 不支持：${message}`, type: 'api_error', code: 'invalid_request_error' } },
    400,
  );
}

/** v1 范围守卫：tools / vision / search 任意一个出现即抛 400。
 *  不能让请求走到 bridge 才失败——bridge 不会拒绝，会傻傻把 send 发出去再等 done。
 *  reasoning 不在其中：接受但忽略（理由见文件头注释）。 */
function assertV1Scope(req: ProviderCompletion): void {
  if (req.tools !== undefined && req.tools.length > 0) {
    throw v1GuardError(`tools（function calling）暂未实现，请移除 tools 参数或改用 deepseek provider`);
  }
  // vision：messages 中任一 user message 的 content 是 ContentBlock[] 含 image_url 块即拒
  if (Array.isArray(req.messages)) {
    for (let i = 0; i < req.messages.length; i++) {
      const m = req.messages[i] as Message | undefined;
      if (m && Array.isArray(m.content)) {
        const blocks = m.content as ContentBlock[];
        const hasImage = blocks.some((blk) => blk.type === 'image_url');
        if (hasImage) throw v1GuardError(`vision（图片输入）暂未实现，请改用纯文本或 deepseek-flash provider`);
      }
    }
  }
  // overrides.reasoning：接受但忽略（2026-10-02）。思考流由 ChatGPT 网页侧自主决定，桥接
  // 没有透传/关闭通道；抛错不能让调用方得到「不思考」，只会让 ChatGPT 在默认带 reasoning 的
  // 调用方（如 debug 页）完全不可用。adapter 层没有 LogEntry.warnings 之类的通道（该字段由
  // router 写），故不新造日志系统，只在此注释说明忽略行为。
  // overrides.search=true → 拒（v1 不支持搜索开关）
  if (req.overrides?.search === true) {
    throw v1GuardError(`search override 暂未实现（v1 不暴露搜索开关）`);
  }
}

// ===== adapter 实现 =====

export function createChatGPTAdapter(deps: ChatGPTAdapterDeps): IProviderAdapter {
  // session 字段：providerId / webSessionId / parentMessageId
  //   webSessionId 在 ChatGPT 语义里就是 conversationId（router 的 mapper 会用这个字段跟踪会话）。
  //   parentMessageId ChGPT 端不传——服务端按 conversationId 自动接续；这里始终 null（adapter 视角无意义）。
  //   createSession 返回 webSessionId='' 占位——bridge 端首次拿到 'conversation' 事件后才会填。
  const createSession = async (_ctx: ProviderContext): Promise<ProviderSession> => ({
    providerId: 'chatgpt',
    webSessionId: '',
    parentMessageId: null,
  });

  const deleteSession = async (_ctx: ProviderContext, _s: ProviderSession): Promise<void> => {
    // ChatGPT 没有 webSessionId 资源可删——「session」概念就是 conversation_id；
    // 真要删只能让用户在 chatgpt.com 网页上删会话。noop 即可。
  };

  const stopStream = async (_ctx: ProviderContext, _s: ProviderSession, _messageId: number | string | null): Promise<void> => {
    // ChatGPT 网页不暴露 stopStream——要么关 tab（断桥 → bridge error），要么 navigate 离开当前会话。
    // best-effort noop；bridge 端通过 cancel/return 结束迭代即可（bridge-client.request 走 iterator.return）。
  };

  return {
    id: 'chatgpt',
    auth: {
      loginPageUrl: CHATGPT_LOGIN_PAGE,
      getAuthStatus: (ctx) => getAuthStatus(ctx, deps.bridge),
    },

    createSession,
    deleteSession,
    stopStream,

    async *streamCompletion(ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
      // v1 守卫——入口即查（throw 而非 yield stream_error，否则 consumer 会以「流正常结束」处理）
      assertV1Scope(req);

      // 2026-10-04（fix/chatgpt-owned-tab）：先把扩展**自己的** chatgpt.com 标签页准备好
      // （不存在就开、等 relay 连上），再判连接。顺序不能反：专属 tab 还没建时 hasConnection()
      // 必然 false，先判就永远走不通。
      // ensureReady 抛错（开不出窗口等）转 stream_error：裸 throw 会被 router 归成 500
      // internal_error，用户看不到任何可行动信息（同下面无连接时的考虑）。
      try {
        await deps.bridge.ensureReady();
      } catch (e) {
        yield {
          kind: 'stream_error',
          message: `ChatGPT 桥接准备失败：${e instanceof Error ? e.message : String(e)}。`
            + '扩展需要一个自己的 chatgpt.com 标签页（独立窗口）来转发请求，请检查浏览器是否拦截了扩展新开窗口。',
        };
        return;
      }

      // 2026-10-03（fix/chatgpt-no-tab-clear-error）：桥接仍未连上时提前报可行动错。
      // 不提前的话，bridge.request 的 throw（'no chatgpt tab connected'）发生在 async
      // generator 体内，要等第一次 .next() 才冒出来，且它是普通 Error：router 的 mapErrStatic
      // 逐 adapter 问 isRateLimited/isAuthExpired/isUnavailable，chatgpt 三个全 false → 归成
      // 500 internal_error，用户既看不到原因也不知道该干什么（实测：无 chatgpt.com 标签页时
      // debug 页发送后零反馈、日志 tab 空白）。
      // 为什么 yield stream_error 而不是 throw：router 在流内 case 'stream_error' 会记下
      // message，流末统一抛 503 provider_unavailable 并把 message 原文透给调用方——正是我们
      // 想要的「可行动提示」。throw 只会得到 500。
      // 位置在 v1 守卫之后：请求本身不合法（400）是更前置的问题，不该被「没开标签页」盖住。
      if (!deps.bridge.hasConnection()) {
        yield {
          kind: 'stream_error',
          message:
            'ChatGPT 桥接未连接：扩展已尝试打开自己的 chatgpt.com 标签页（独立窗口）但没能连上。'
            + '请保持该标签页处于打开状态并已登录 chatgpt.com（若被关闭，下次请求会自动重建）；'
            + '页面首次加载较慢时稍后重试。',
        };
        return;
      }

      // 与 bridge.request 对话：把 prep 中已发但未拿到的 conversationId 作为 conversationId 传入
      // （router 拿到的 req.session.webSessionId 是 mapper 注册时用的占位 webSessionId；
      // 对 ChatGPT 来说，webSessionId === conversationId。incremental 时 mapper 填的是上一轮的
      // conversationId——直接转发给 MAIN world 即可）。
      const conversationId = req.session.webSessionId === '' ? null : req.session.webSessionId;
      const stream = deps.bridge.request({
        requestId: req.requestId,
        text: req.prompt,
        conversationId,
      });

      const state: ChatGPTStreamState = newStreamState();
      for await (const ev of stream) {
        switch (ev.kind) {
          case 'stream-start':
            // 不产 ProviderStreamEvent——它是 bridge 给 consumer 的「send 已发出 fetch 即将到」的信号，
            // 路由器用不上（路由器只看流内容）。
            continue;
          case 'frame': {
            // 把 SseFrame 形式喂给 stream.ts 解释器（frame 直接就是 { event, data }）
            for (const e of interpretFrame({ event: ev.event, data: ev.data }, state)) yield e;
            break;
          }
          case 'conversation':
            // 把 conversationId 回填到 session.webSessionId——下次 incremental 复用同一会话
            if (req.session.webSessionId !== ev.conversationId) req.session.webSessionId = ev.conversationId;
            continue;
          case 'done':
            return;
          case 'error':
            yield { kind: 'stream_error', message: ev.message };
            return;
        }
      }
      // 正常 done 后 iterator 自然结束——不产额外事件
      void ctx;
    },

    models: MODELS,
    resolveModel,
    // ChatGPT 不在 SW 端做错误分类（router 的 mapErrStatic 会逐 adapter 问 → 全 false →
    // 最终归类为内部错误）。本 provider 自己产生的 stream_error 已在 streamCompletion 内产，
    // router 据此抛 503 provider_unavailable。
    isRateLimited: () => false,
    isAuthExpired: () => false,
    isUnavailable: () => false,
  };
}

// ===== 类型重导出（测试 & 上层 import 友好）=====
export type { ResolvedModel };