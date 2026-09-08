export interface LogEntry { at: number; provider: string; model: string; ok: boolean; ms: number; error?: string }

export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry): void { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}
