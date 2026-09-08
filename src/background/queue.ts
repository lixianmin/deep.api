export class QueueTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'QueueTimeoutError'; } }

interface Pending { startedAt: number; resolve: () => void; reject: (e: unknown) => void }

export class Queue {
  private lockKey: string | null = null;
  private pending: Pending[] = [];

  constructor(private opts: { timeoutMs: number; now?: () => number } = { timeoutMs: 60_000 }) {}

  /** 显式 acquire/release：调用者持有锁期间自行调用 release()。超时抛 QueueTimeoutError。 */
  async acquire(key: string, timeoutMs: number = this.opts.timeoutMs): Promise<() => void> {
    const now = this.opts.now ?? Date.now;
    const start = now();
    if (this.lockKey === null) {
      this.lockKey = key;
      return () => this.release(key);
    }
    return new Promise<() => void>((resolve, reject) => {
      this.pending.push({
        startedAt: start,
        resolve: () => { this.lockKey = key; resolve(() => this.release(key)); },
        reject,
      });
      const waitMs = Math.max(0, timeoutMs - (now() - start));
      const t = setTimeout(() => {
        const i = this.pending.findIndex(p => p.reject === reject);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new QueueTimeoutError(`queue acquire wait exceeded ${timeoutMs}ms`));
      }, waitMs);
      (t as { unref?: () => void }).unref?.();
    });
  }

  private release(key: string): void {
    if (this.lockKey !== key) return;
    const next = this.pending.shift();
    if (next) next.resolve();
    else this.lockKey = null;
  }

  /** 旧 API：跑 fn 至结束，期间独占 key。timeoutMs 默认 constructor 的值。 */
  runExclusive(key: string, fn: () => Promise<void>, timeoutMs: number = this.opts.timeoutMs): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.acquire(key, timeoutMs).then(release => fn().then(resolve, reject).finally(release)).catch(reject);
    });
  }

  size(): number { return this.pending.length + (this.lockKey ? 1 : 0); }
}
