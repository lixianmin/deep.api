/**
 * ChatGPT provider SSE 帧解释器（纯函数）。
 *
 * 协议来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 * ——真实抓帧（18 帧 / span 6783ms / INCREMENTAL）。
 *
 * 职责：把上游 SSE 帧（已由 src/shared/chatgpt-sse.ts 拆帧解析）转成 provider 流事件。
 *         不消费原始字节，不发网络请求；不写日志、不更新 storage。
 *
 * 三个最易写错的点（doc §「解析规则」逐条对应实现）：
 *  1. p/o 跨帧继承：只带 {"v":"..."} 的帧沿用 state.lastP/lastO；
 *     真实帧 11/12 是正文续帧——不继承会让正文整段丢失。
 *  2. patch 数组展开：{"p":"","o":"patch","v":[...]} 的 v 是操作数组，
 *     要对每项递归走 processSingleOp；数组内的 append 与顶层同等处理。
 *  3. 通道分界：marker 含 "final_channel_token" → state.phase 切到 'content'；
 *     之前所有正文产 think_delta，之后产 content_delta。
 *     实测两种 marker 形态都成立：(a) 两个独立帧各带一个 marker——帧 6 "user_visible_token"
 *     与帧 9 "final_channel_token"（传 docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 *     帧序列）；(b) 一帧里 marker 为 "user_visible_token|final_channel_token" 合并值。
 *     代码以 includes('final_channel_token') 判定，对两种形态都能切通道——代码逻辑不变。
 *
 * 设计决策（写下来备查）：
 *  - resume_conversation_token 不发事件。ProviderStreamEvent 现有事件集无 conversationId 类型
 *    （adapter.ts 只列了 message_id / think_delta / content_delta / usage / stream_stats /
 *    stream_error）。为不破坏类型契约且不臆造新事件，conversationId 由 bridge-client 层
 *    （Task 4）从 SseFrame.data 直接读取下传（混入内容流会污染 router 的 think_delta/usage 累计）。
 *  - message_stream_complete 不发事件。流在它之后自然结束于 [DONE] / body close；router
 *    靠迭代器结束判定终止，不靠显式终止事件（chunk-encoder.ts 对每个事件 kind 有明确处理）。
 *  - error 字段兜底放在 type 字段路由之后——避免误把正常 marker 等顶层 type 字段当错误。
 */
import type { ProviderStreamEvent } from '../adapter';
import type { SseFrame } from '../../../shared/chatgpt-sse';

/** 跨帧继承状态（持续聊天 + 增量流必需）。 */
export interface ChatGPTStreamState {
  /** 上一次 delta 帧的 path（缺省时继承给下一帧）。空串表示「未设置」+ 是 patch 顶层标识。 */
  lastP: string;
  /** 上一次 delta 帧的 op（缺省时继承给下一帧）。 */
  lastO: string;
  /** 通道分界：final_channel_token 之前=reasoning（think_delta），之后=content（content_delta）。 */
  phase: 'reasoning' | 'content';
}

/** 新一轮对话的初始状态：phase 从 reasoning 开始，p/o 待第一帧填充。 */
export function newStreamState(): ChatGPTStreamState {
  return { lastP: '', lastO: '', phase: 'reasoning' };
}

/**
 * 把单帧解释成 0/1/N 个 ProviderStreamEvent。
 * 解释期间会修改 state（更新 lastP/lastO、phase）——所以 state 必须跨调用持久化（call site 自己管）。
 */
export function interpretFrame(frame: SseFrame, state: ChatGPTStreamState): ProviderStreamEvent[] {
  // data 保留原始字符串（Task 1 拆帧不解析 JSON）；非 JSON 帧（[DONE] / 心跳失败等）→ 静默忽略
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;

  // 顶层 type 字段优先路由——避免误把 {"type":"message_marker",...} 当 delta op
  const type = obj.type;
  if (typeof type === 'string') {
    switch (type) {
      // 这些帧是协议信封/元数据，不产生内容事件
      case 'delta_encoding':
      case 'title_generation':
      case 'server_ste_metadata':
      case 'resume_conversation_token':   // 见文件头注释
      case 'message_stream_complete':     // 流自然结束；不产事件，靠迭代终止判定
        return [];
      case 'message_marker':
        handleMarkerPhase(obj, state);
        return [];
      case 'error':
        // 实测错误帧形如 {"type":"error","content":"...","finish_reason":"generation_err"}；
        // 与 DeepSeek 同构，adapter.ts 的 stream_error 接好
        return buildStreamError(obj);
    }
  }

  // 非 type 路由帧：要么是 delta op（顶层 p/o/v），要么是含 error/error_code 的快照/异常帧
  // 顶层 error 字段兜底（doc §「错误信号」：「快照里的 error / error_code 字段非空」）
  const directError = errorFrameEvent(obj);
  if (directError !== null) return [directError];

  // delta 帧：取 p/o（缺省沿用 state.lastP/lastO），单条或数组
  return processDeltaOp(obj, state);
}

/** 把 message_marker 帧按 marker 字符串切通道。state 由 caller 传入以修改。 */
function handleMarkerPhase(obj: Record<string, unknown>, state: ChatGPTStreamState): void {
  const marker = obj.marker;
  if (typeof marker !== 'string') return;
  // doc §「解析规则 4」：final_channel_token 之前的正文属 reasoning，之后属正式回复。
  // marker 实测可能单独 "final_channel_token" 或合并 "user_visible_token|final_channel_token"
  if (marker.includes('final_channel_token')) {
    state.phase = 'content';
  }
}

/**
 * delta 帧主路径：取 p/o（缺省沿用 state）、更新 state（驱动下一帧继承），按需展开 patch 数组。
 */
function processDeltaOp(obj: Record<string, unknown>, state: ChatGPTStreamState): ProviderStreamEvent[] {
  const hasP = typeof obj.p === 'string';
  const hasO = typeof obj.o === 'string';
  const p = hasP ? obj.p as string : state.lastP;
  const op = hasO ? obj.o as string : state.lastO;
  const v = obj.v;

  // 快照里的 error/error_code 字段（doc §「错误信号」）：v 是消息快照对象时检查
  // patch 操作（v 是数组）走下方专门展开逻辑，不与快照状态路径重复
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const vErr = errorFrameEvent(v as Record<string, unknown>);
    if (vErr !== null) return [vErr];
  }

  // 先更新 state（patch 数组内的子项也要更新，所以这里无条件赋值；缺省值仍沿用旧值）
  if (hasP) state.lastP = p;
  if (hasO) state.lastO = op;

  // patch 操作 → 展开数组（doc §「解析规则 3」）
  if (p === '' && op === 'patch' && Array.isArray(v)) {
    const events: ProviderStreamEvent[] = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue;
      const itemObj = item as Record<string, unknown>;
      // 数组内的子项也走同一套继承：缺省沿用上一项更新后的 state.lastP/lastO
      const itemP = typeof itemObj.p === 'string' ? (state.lastP = itemObj.p) : state.lastP;
      const itemO = typeof itemObj.o === 'string' ? (state.lastO = itemObj.o) : state.lastO;
      events.push(...processSingleOp(itemP, itemO, itemObj.v, state));
    }
    return events;
  }

  return processSingleOp(p, op, v, state);
}

/** 单条 op → ProviderStreamEvent。命中正文 append 才产出事件；其余忽略（status/metadata/end_turn 等）。 */
function processSingleOp(p: string, op: string, v: unknown, state: ChatGPTStreamState): ProviderStreamEvent[] {
  // 正文 path = /message/content/parts/0，op = append，v = 字符串增量
  // 严格相等而非 startsWith——避免误把 /message/content/parts/0/extra 之类当正文
  if (p === '/message/content/parts/0' && op === 'append' && typeof v === 'string') {
    if (state.phase === 'content') return [{ kind: 'content_delta', content: v }];
    return [{ kind: 'think_delta', content: v }];
  }
  return [];
}

/** 检测顶层 error / error_code 字段，构造 stream_error；都不为空时也只产一个事件。 */
function errorFrameEvent(obj: Record<string, unknown>): ProviderStreamEvent | null {
  const errField = obj.error;
  const codeField = obj.error_code;
  const errStr = typeof errField === 'string' && errField !== '' ? errField : null;
  const codeStr = typeof codeField === 'string' && codeField !== '' ? codeField : null;
  if (errStr === null && codeStr === null) return null;
  // 优先 error 字段的内容作为 message；缺 error 时回落到 error_code
  const message = errStr ?? `error_code: ${codeStr}`;
  return { kind: 'stream_error', message, reason: codeStr ?? undefined };
}

/** 处理 {"type":"error",...} 形态：content 字段做 message，finish_reason 做 reason。 */
function buildStreamError(obj: Record<string, unknown>): ProviderStreamEvent[] {
  const content = obj.content;
  const reason = obj.finish_reason;
  const message = typeof content === 'string' && content !== ''
      ? content
      : (typeof obj.error === 'string' ? obj.error : 'unknown stream error');
  return [{
    kind: 'stream_error',
    message,
    reason: typeof reason === 'string' ? reason : undefined,
  }];
}