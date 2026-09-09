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
  // 2026-09-09（fix/thread-persistence）：模型输出原文（前 200 字）——「文字+JSON 没触发工具」
  // 排查：finishReason=stop 时用户只能看到 UI 文本；replySample 直接给出 deep.api 收到的模型原文，
  // 一眼判断是「无标签 JSON」还是「标签在但解析失败」。
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
}

export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry): void { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}