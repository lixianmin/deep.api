// 2026-09-09（feat/diagnostic-logging）：扩展 LogEntry 加路由决策现场——spice 报「chat thread 反复被删」需
// 人工/AI 排查时能直接复制 popup 日志看 decision.action / threadFound / deletedOld，
// 不必再开 SW DevTools。
export interface LogEntry {
  at: number;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
  // 2026-09-09（diag/version-stamp）：运行版本自证。用户「重装后还是旧行为」时一眼看出。
  version?: string;
  // 诊断字段（可选，老条目不带也不破坏 popup 渲染）
  cid?: string;
  msgsLen?: number;
  action?: 'rebuild' | 'incremental' | 'error';
  threadFound?: boolean;
  mirrorLen?: number;
  deletedOld?: boolean;
  webSessionId?: string;
  parentMessageId?: string | number | null;
  finishReason?: string;
  // 2026-09-09（fix/mirror-content）：mirrorIsPrefix 失败时定位现场
  firstDiffIdx?: number;                                        // 第一条不同消息的索引（mirror 与 messages 比较）
  // 2026-09-09（fix/full-tool-prompt）：完整内容（复制 JSON 时拿到全部 user/assistant/tool 消息原文）
  messagesFull?: string;                                        // 本请求 messages 完整 JSON
  mirrorFull?: string;                                          // 本 thread mirror 完整 JSON
  // 2026-09-09（fix/thread-persistence）：模型输出原文（前 1200 字）——「文字+JSON 没触发工具」
  // 排查：finishReason=stop 时用户只能看到 UI 文本；replySample 直接给出 deep.api 收到的模型原文，
  // 一眼判断是「无标签 JSON」还是「标签在但解析失败」。
  // 2026-09-10（fix/dsml-tolerant-closes）：200 → 1200。DSML 块（5 个工具调用）超过 200 字符，
  // 截断处恰好落在闭合标签之前，只能看到开标签，无法判断是不是闭合标签缺命名空间。
  replySample?: string;
  // 2026-09-09（diag/reasoning-sample）：推理/思考原文（前 200 字）——spice 用户报 Pro 模型返空 content
  // 但 finishReason=stop。严重怀疑 Pro（model_type=expert）在 DeepSeek 网页 web API 上只返 reasoning 不返
  // content（与 Flash 默认不同），当前 log 只记 replySample，reasoning 被静默丢，排查现场看不见。
  // 修：同时记 reasoningSample，与 replySample 并列；一眼看出 Pro 是否只返了 thinking。
  reasoningSample?: string;
  // 2026-09-09（diag/pro-sse-paths）：SSE 原始调试。bytes 判上游是否真返了数据；paths 判 Pro 是只返
  // fragments (含 think/response) 还是返了未识别 path。排查 Pro 空响应的唯一现场。
  //   场景 B-1：bytes > 0 + paths 只含 fragments/type=think → Pro 只返了 thinking，思维后面没接 content
  //   场景 B-2：bytes > 0 + paths 含 unknown:xxx → Pro 返了我没解析的字段
  //   场景 B-3：bytes == 0 + paths == [] → 上游完全没返（与 onStreamError 不同路径）
  sseBytes?: number;
  ssePaths?: string[];
  sseRaw?: string;
  // 2026-09-11（diag/continue-thinking）：spike 期间临时诊断字段——定位 DeepSeek 网页 thinking
  // 截断触发点。sseStatusValues 是 response/status 路径下观察到的全部 value；sseThinkingChars /
  // sseResponseChars 是截至流末 THINK/RESPONSE fragment 字符累计（设阈值用）；sseRawTail 是流末
  // 最后 600 字符原始 SSE（含 status 终值与可能的 finish 事件）。设计冻结后会被 continue_required
  // 事件 + 自动续接逻辑替代。
  sseStatusValues?: string[];
  sseThinkingChars?: number;
  sseResponseChars?: number;
  sseRawTail?: string;
  sseRawTailB64?: string;                                       // sseRawTail 的 base64（粘贴链不掉字节）
  // 2026-09-11（fix/incomplete-stream-error）：服务端 Continue 决策字段（click_behavior 帧）——
  // auto_resume=false 实测仍会出 Continue 按钮（用户网页实测），先全量记录供下一阶段设计。
  sseAutoResume?: boolean;
  sseHasPendingFragment?: boolean;
  // 2026-09-12（feat/continue-on-incomplete）：本次请求实际续接次数（0 = 未续接）。
  continueAttempts?: number;
  // 2026-09-10（feat/log-b64-export）：上面三个现场字符串的 base64（纯 ASCII）。
  // 动机：DSML 标记（｜DSML｜，U+FF5C）在「聊天/终端粘贴」链路上会被吃掉——用户贴回来的样本
  // 永远看不到它，导致无法判断现场字节形态。base64 只含 A-Za-z0-9+/=，可无损跨粘贴链；
  // 原字段与 base64 字段同时保留（人眼可读 + 字节可验）。切片上限见 router 的 B64_SAMPLE_CHARS。
  replyB64?: string;                                        // replySample 的 base64
  rawB64?: string;                                          // 归一化**前**的模型原文 base64
  sseRawB64?: string;                                       // sseRaw 的 base64（最上游：SSE 原始帧样本）
  // 2026-09-10（diag/request-snapshot）：本次真正发给 chat.deepseek.com 的关键参数快照
  // （model_type / thinking / search / reasoning_effort / tool_choice / tools 名单 / ref_file_ids 数 /
  // prompt 长度）。动机：同一模型下 demo 场景返回标准 <tool_calls>，spice 请求返回 DSML——
  // 两条路径共用 router.create()，差异只可能在输入侧；原日志只有 client messages，无法两边 diff。
  requestFull?: string;
  // 2026-09-11（fix/vision-poll-timeout）：非致命警告（如「图片轮询超时未确认就绪，已继续发送」）。
  // 继续发 completion 是刻意设计（对齐参考实现 llmweb2api），但操作员必须在日志里看到这个事实。
  warnings?: string[];
  // 2026-09-15（feat/log-copy-slim）：请求侧现场——最后一条 user 消息前 200 字。
  // 动机：user 消息此前只在 messagesFull 全量里（popup UI 不显示、取证白名单不带），
  // 排查时「模型到底收到了什么问题」看不见。截断 200 字兼顾可见性与体积。
  lastUserSample?: string;
}

/**
 * UTF-8 字符串 → base64（纯 ASCII）。给现场取证用：DSML 标记（｜DSML｜）在聊天/终端粘贴链上会被
 * 吃掉，base64 能逐字节还原。空输入返回 undefined（不写空字段）；环境无 btoa 时不抛，返 undefined。
 * 2026-09-10（feat/log-b64-export）。
 */
export function toB64(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    let bin = '';
    for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
    return btoa(bin);
  } catch { return undefined; }
}

export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry): void { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}