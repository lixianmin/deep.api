export class QueueTimeoutError extends Error {
  constructor(m: string) { super(m); this.name = 'QueueTimeoutError'; }
}

export class Queue {
  private tails = new Map<string, Promise<void>>();
  constructor(private opts: { timeoutMs: number; now?: () => number }) {}

  runExclusive(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const start = (this.opts.now ?? Date.now)();
    const run = prev.catch(() => {}).then(async () => {
      const waited = (this.opts.now ?? Date.now)() - start;
      if (waited > this.opts.timeoutMs) throw new QueueTimeoutError(`queue wait exceeded ${this.opts.timeoutMs}ms`);
      await fn();
    });
    const tail = run.catch(() => {});
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return run;
  }

  size(): number { return this.tails.size; }
}
