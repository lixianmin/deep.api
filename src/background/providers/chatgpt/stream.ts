/**
 * ChatGPT provider SSE 帧解释器（纯函数）。
 *
 * 协议来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 * ——真实抓帧（18 帧 / span 6783ms / INCREMENTAL）。
 *
 * 职责：把上游 SSE 帧（已由 src/shared/chatgpt-sse.ts 拆帧解析）转成 provider 流事件。
 *         不消费原始字节，不发网络请求；不写日志、不更新 storage。
 *
 * 四个最易写错的点（doc §「解析规则」逐条对应实现）：
 *  1. p/o 跨帧继承：只带 {"v":"..."} 的帧沿用 state.lastP/lastO；
 *     真实帧 11/12 是正文续帧——不继承会让正文整段丢失。
 *  2. ops 批次展开：帧级 v 是操作数组（[{"p":...,"o":...,"v":...}, ...]）时逐项递归处理。
 *     实测两种形态——文档形态 {"p":"","o":"patch","v":[...]}（协议 doc 帧 13）与观测形态
 *     {"v":[...]}（帧级根本没有 p/o，2026-10-02 抓帧一次回答 8 个批次帧里有 6 个是这种）；
 *     判定不能拿 p === '' 当依据——p/o 是跨帧继承的（见规则 1），观测形态下 p 会继承成上一次的
 *     /message/content/parts/0，p === '' 不成立 → 整批 ops（含正文）被当单条 op（v 是数组）丢掉。
 *     这就是「正文大面积丢失 / 中段错位 / 结尾截断」的根因（同一段回答实测只产出 194 字符，页面真值 536）。
 *  3. 通道分界：marker 含 "final_channel_token" → state.phase 切到 'content'；
 *     之前所有正文产 think_delta，之后产 content_delta。
 *     实测两种 marker 形态都成立：(a) 两个独立帧各带一个 marker——帧 6 "user_visible_token"
 *     与帧 9 "final_channel_token"（传 docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 *     帧序列）；(b) 一帧里 marker 为 "user_visible_token|final_channel_token" 合并值。
 *     代码以 includes('final_channel_token') 判定，对两种形态都能切通道——代码逻辑不变。
 *  4. 引用标记清洗：正文里内联着 \uE200cite\uE202turn0newsN\uE201（网页 UI 渲染成来源角标），
 *     作为 API 文本是垃圾字符 → 删除；正文分片到达、标记可能被切成两半，故清洗必须跨帧扣留
 *     （见 stripCiteMarkers）。
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

/** 引用标记码点（2026-10-02 抓帧实测）：U+E200 起始、U+E202 分隔、U+E201 结束。 */
const CITE_START = '\uE200';
const CITE_END = '\uE201';

/** 成对标记（\uE200…\uE201，含中间的分隔符 U+E202 与来源名）。非贪婪：连续多个标记逐个匹配。 */
const CITE_MARKER_RE = /\uE200[\s\S]*?\uE201/g;

/**
 * 扣留缓冲的长度上界（字符数）：超过它，挂起内容就不再当标记看，改当正文原样放出。
 *
 * 取 64 的来由：完整标记实测形态 \uE200cite\uE202turn0newsN\uE201 只有 ~20 个字符（13 个固定字符
 * + 来源编号），64 是它的 3 倍余量——足够容忍任意变形（多来源、长编号、夹杂空白），又远小于
 * 任何一段正文。没有上限时，一个永不闭合的 U+E200 会把其后所有正文一直扣住、流结束时整体丢弃，
 * 用户拿到被静默截断的回答（真实数据里出现过残缺标记：正文里内联着没闭合的 \uE200cite\uE202turn0）。
 */
const CITE_PENDING_MAX_LEN = 64;

/** 跨帧继承状态（持续聊天 + 增量流必需）。 */
export interface ChatGPTStreamState {
  /** 上一次 delta 帧的 path（缺省时继承给下一帧）。空串表示「未设置」+ 是 patch 顶层标识。 */
  lastP: string;
  /** 上一次 delta 帧的 op（缺省时继承给下一帧）。 */
  lastO: string;
  /** 通道分界：final_channel_token 之前=reasoning（think_delta），之后=content（content_delta）。 */
  phase: 'reasoning' | 'content';
  /**
   * 引用标记清洗的扣留缓冲：最后一个 U+E200 之后还没出现 U+E201 的那半截标记。
   * 未设置（undefined）= 无挂起。与 lastP/lastO 同一层，跨帧持久化。
   * 长度被 CITE_PENDING_MAX_LEN 封顶——超界即判定不是标记，原样当正文放出（见 stripCiteMarkers）。
   * 阈值内未闭合的挂起在流结束时不清空也不补发：残缺标记不是正文，直接丢弃。
   */
  pendingCite?: string;
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

  // 先更新 state（批次内的子项也要更新，所以这里无条件赋值；缺省值仍沿用旧值）
  if (hasP) state.lastP = p;
  if (hasO) state.lastO = op;

  // 帧级 v 是 ops 批次 → 展开（判定见 isOpBatch）。
  // 这里不能沿用旧的 p === '' 判据：p/o 是可继承的，观测形态的批次帧没有 p/o，
  // 此时 p 是继承来的 /message/content/parts/0，p === '' 不成立 → 整批被当单条 op 丢弃。
  if (isOpBatch(v, op)) return expandOps(v, state);

  return processSingleOp(p, op, v, state);
}

/**
 * 帧级 v 是否「ops 批次」（数组元素本身是 {p,o,v} 操作）。
 * 两种真实形态：
 *  - 文档形态 {"p":"","o":"patch","v":[ops]}（协议 doc 帧 13）：op=patch 直接认定；
 *  - 观测形态 {"v":[ops]}（帧级无 p/o）：靠「每个元素都是带字符串 p 的非数组对象」认定——
 *    实测批次内每个元素都自带 p，op 则是继承来的（append / patch 都有）。
 * 反面用例（都是普通 op，v 是字符串数组或「无 p 的对象数组」，绝不能被当批次展开）：
 *  - {"p":"/message/metadata/content_references/0/safe_urls","o":"append","v":["https://…"]}
 *  - {"p":"/message/metadata/content_references","o":"append","v":[{"matched_text":…}]}
 */
function isOpBatch(v: unknown, op: string): v is Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (op === 'patch') return true;
  return v.every((item) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).p === 'string');
}

/** 展开 ops 批次：子项缺省 p/o 沿用继承（与帧级同规则）；子项自身是批次时由本函数递归处理。 */
function expandOps(items: readonly unknown[], state: ChatGPTStreamState): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    // 数组内的子项也走同一套继承：缺省沿用上一项更新后的 state.lastP/lastO
    const itemP = typeof item.p === 'string' ? (state.lastP = item.p) : state.lastP;
    const itemO = typeof item.o === 'string' ? (state.lastO = item.o) : state.lastO;
    if (isOpBatch(item.v, itemO)) {
      events.push(...expandOps(item.v, state));
      continue;
    }
    events.push(...processSingleOp(itemP, itemO, item.v, state));
  }
  return events;
}

/** 单条 op → ProviderStreamEvent。命中正文 append 才产出事件；其余忽略（status/metadata/end_turn 等）。 */
function processSingleOp(p: string, op: string, v: unknown, state: ChatGPTStreamState): ProviderStreamEvent[] {
  // 正文 path = /message/content/parts/0，op = append，v = 字符串增量
  // 严格相等而非 startsWith——避免误把 /message/content/parts/0/extra 之类当正文
  if (p === '/message/content/parts/0' && op === 'append' && typeof v === 'string') {
    // 两个通道都清洗：reasoning 段的思考文本同样会带引用标记
    const content = stripCiteMarkers(v, state);
    if (state.phase === 'content') return [{ kind: 'content_delta', content }];
    return [{ kind: 'think_delta', content }];
  }
  return [];
}

/**
 * 删除正文切片里的内部引用标记，并扣留跨帧断裂的半截标记。
 *
 * 为什么要扣留而不能只做全局替换：正文是流式分片到达的，一个标记可能被切成两半——
 * 上一个 delta 以 "\uE200cit" 结尾、下一个 delta 以 "e\uE202turn0news2\uE201" 开头。
 * 正则只能吃掉同一片内的完整标记，分片处的那半截会原样泄漏给用户，所以先把「最后一个 U+E200
 * 之后没有 U+E201」的尾巴扣在 state.pendingCite 里，等下一帧到了再拼起来一起判。
 * 用户已拍板：标记直接删（不换成链接、不保留来源名），故闭合标记连同中间内容整段丢掉。
 *
 * 扣留有上界（CITE_PENDING_MAX_LEN）：挂起长度超界即「这不可能是标记」，原样当正文放出。
 * 宁可泄漏几个私有区字符，也不能让一个残缺的 U+E200 把其后整段回答吞掉（流结束时挂起内容
 * 是不补发的）。
 */
function stripCiteMarkers(chunk: string, state: ChatGPTStreamState): string {
  const text = (state.pendingCite ?? '') + chunk;
  const lastStart = text.lastIndexOf(CITE_START);
  if (lastStart !== -1 && text.indexOf(CITE_END, lastStart) === -1) {
    const tail = text.slice(lastStart);
    if (tail.length <= CITE_PENDING_MAX_LEN) {
      // 未闭合且在阈值内：从最后一个起点起的尾巴全部扣留（含上一帧扣留的部分），前面已能确认的部分先发
      state.pendingCite = tail;
      return text.slice(0, lastStart).replace(CITE_MARKER_RE, '');
    }
    // 超界：不是标记，落到下面的「全部当正文」分支——tail 里没有 U+E201，replace 不会动它
  }
  state.pendingCite = undefined;
  return text.replace(CITE_MARKER_RE, '');
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