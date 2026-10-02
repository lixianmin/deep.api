/**
 * ChatGPT provider adapter（实现 ProviderAdapter 接口）。
 *
 * 链路：Router → ChatGPTAdapter.streamCompletion → ChatGPTBridge → ISOLATED relay → MAIN world
 * 钩子 → chatgpt.com 页面 fetch → 流式 SSE → 旁路 tap → MAIN world postMessage → ISOLATED
 * relay → ChatGPTBridge → adapter 把 frame 喂给 ChatGPT stream 解释器 → ProviderStreamEvent。
 *
 * v1 范围（brief 铁律）：不支持 tool_calls / vision / reasoning / search。
 * 收到这些参数必须抛 400 invalid_request_error 并说明「v1 不支持」——不能静默忽略
 * （静默会让 spice 等调用方误以为能力存在）。守卫位置在 streamCompletion 入口，过 gate
 * 失败即抛；bridge 不发。
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

/** v1 范围守卫：tools / vision / reasoning / search 任意一个出现即抛 400。
 *  不能让请求走到 bridge 才失败——bridge 不会拒绝，会傻傻把 send 发出去再等 done。 */
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
  // overrides.reasoning 非 undefined → 拒（v1 不支持自定义 reasoning 等级，ChGPT 网页自有流量通道）
  if (req.overrides?.reasoning !== undefined) {
    throw v1GuardError(`reasoning override 暂未实现（v1 由 ChatGPT 网页侧自主决定思考流，请移除 reasoning 字段）`);
  }
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