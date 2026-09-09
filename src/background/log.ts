// 2026-09-09（feat/diagnostic-logging）：扩展 LogEntry 加路由决策现场——spice 报「chat thread 反复被删」需
// 人工/AI 排查时能直接复制 popup 日志看 decision.action / threadFound / mirrorPrefixOk / deletedOld，
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
  mirrorPrefixOk?: boolean;
  mirrorLen?: number;
  deletedOld?: boolean;
  webSessionId?: string;
  parentMessageId?: string | number | null;
  finishReason?: string;
  // 2026-09-09（fix/mirror-content）：mirrorIsPrefix 失败时定位现场
  firstDiffIdx?: number;                                        // 第一条不同消息的索引（mirror 与 messages 比较）
  firstDiffDetail?: string;                                     // 两端该条消息的 role + content 摘要对比
  messagesSample?: string;                                      // 本请求 messages 摘要（每条约 60 字，popup 展示用）
  mirrorSample?: string;                                        // 本 thread mirror 摘要（每条约 60 字）
  // 2026-09-09（fix/full-tool-prompt）：完整内容（复制 JSON 时拿到全部 user/assistant/tool 消息原文）
  messagesFull?: string;                                        // 本请求 messages 完整 JSON
  mirrorFull?: string;                                          // 本 thread mirror 完整 JSON
  // 2026-09-09（fix/thread-persistence）：模型输出原文（前 200 字）——「文字+JSON 没触发工具」
  // 排查：finishReason=stop 时用户只能看到 UI 文本；replySample 直接给出 deep.api 收到的模型原文，
  // 一眼判断是「无标签 JSON」还是「标签在但解析失败」。
  replySample?: string;
}

export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry): void { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}