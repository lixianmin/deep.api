export class QueueTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'QueueTimeoutError'; } }

interface Pending {
  key: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
}

/** 每 key 互斥 + 全局并发上限。
 *  2026-09-11（fix/queue-poolsize）：旧实现只有一把全局锁（lockKey: string | null），
 *  不同 webSession 也串行 → spec §4.3 的「每 provider 线程池上限 poolSize（默认 2，面板可调 1–5）」
 *  完全失效：第二个请求要等第一条流跑完，超过 60s 直接被打成 429 busy。
 *  现在：同一 key（providerId:webSessionId）仍然严格串行（spec「每线程同一时刻最多 1 个在途」），
 *  不同 key 在 concurrency 个槽位内并行；concurrency 由 sw.ts 用 provider 的 poolSize 注入。 */
export class Queue {
  private active = new Set<string>();
  private pending: Pending[] = [];
  private concurrency: number;

  constructor(private opts: { timeoutMs: number; now?: () => number; concurrency?: number } = { timeoutMs: 60_000 }) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  }

  /** 面板改 poolSize 时实时生效（spec §8.2）；缩容不驱逐在跑的请求，只影响后续排队。 */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n) || 1);
    this.pump();
  }

  /** 显式 acquire/release：调用者持有锁期间自行调用 release()。超时抛 QueueTimeoutError。 */
  async acquire(key: string, timeoutMs: number = this.opts.timeoutMs): Promise<() => void> {
    if (this.canStart(key)) {
      this.active.add(key);
      return this.releaseFn(key);
    }
    const now = this.opts.now ?? Date.now;
    const start = now();
    return new Promise<() => void>((resolve, reject) => {
      const p: Pending = { key, startedAt: start, timer: null, settled: false, resolve, reject };
      this.pending.push(p);
      const waitMs = Math.max(0, timeoutMs - (now() - start));
      const t = setTimeout(() => {
        if (p.settled) return;
        p.settled = true;
        const i = this.pending.indexOf(p);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new QueueTimeoutError(`queue acquire wait exceeded ${timeoutMs}ms`));
      }, waitMs);
      (t as { unref?: () => void }).unref?.();
      p.timer = t;
    });
  }

  private canStart(key: string): boolean {
    return !this.active.has(key) && this.active.size < this.concurrency;
  }

  /** 幂等 release：双次调用不会误释放后来者持有的同 key 槽位（旧实现按 key 名比对，存在此缺陷）。 */
  private releaseFn(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.active.has(key)) return;
      this.active.delete(key);
      this.pump();
    };
  }

  private pump(): void {
    for (let i = 0; i < this.pending.length;) {
      const p = this.pending[i]!;
      if (!this.canStart(p.key)) { i++; continue; }
      this.pending.splice(i, 1);
      p.settled = true;
      if (p.timer !== null) clearTimeout(p.timer);
      this.active.add(p.key);
      p.resolve(this.releaseFn(p.key));
    }
  }

  /** 旧 API：跑 fn 至结束，期间独占 key。timeoutMs 默认 constructor 的值。 */
  runExclusive(key: string, fn: () => Promise<void>, timeoutMs: number = this.opts.timeoutMs): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.acquire(key, timeoutMs).then(release => fn().then(resolve, reject).finally(release)).catch(reject);
    });
  }

  size(): number { return this.pending.length + this.active.size; }
}
