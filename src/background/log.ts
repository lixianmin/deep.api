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
}

export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry): void { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}