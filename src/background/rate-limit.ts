/**
 * 上游站点请求节流（2026-10-01，feat/rate-limit）。
 *
 * 需求（用户原话）：走同一个网站（当前只有 chat.deepseek.com，日后接 ChatGPT）的请求，
 * 每秒最多一次；超过就拒绝，**哪怕是不同的 session、不同的 thread** 也一起算。
 * 动机不是省钱也不是防重复，而是反自动化检测：不要让 DeepSeek 看到脚本在并发冲击它的网页。
 *
 * 因此限流键是 provider（= 上游网站），不是 session/thread/conversation_id——按后两者分桶
 * 等于没限。
 */
export interface RateLimitDecision {
  ok: boolean;
  /** 距下一格窗口的剩余毫秒（ok=false 时 > 0），用于写进 429 的 message。 */
  retryAfterMs: number;
}

/** 滑动窗口：两次**放行**之间的间隔必须 ≥ minIntervalMs。被拒的调用不推进窗口。 */
export class SlidingWindowLimiter {
  // -Infinity 让首次调用无条件放行（等价于「很久以前通过过」），minIntervalMs=0 时也成立。
  private lastPassAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minIntervalMs: number, private readonly now: () => number = Date.now) {}

  tryAcquire(): RateLimitDecision {
    const t = this.now();
    const elapsed = t - this.lastPassAt;
    if (elapsed >= this.minIntervalMs) {
      this.lastPassAt = t;
      return { ok: true, retryAfterMs: 0 };
    }
    // 拒绝时**不**更新 lastPassAt：窗口始终从上次放行起算，越拒越久的行为被刻意排除
    // （否则连续试探性请求会把正常请求挡在越来越远的未来）。
    return { ok: false, retryAfterMs: this.minIntervalMs - elapsed };
  }
}

/** 每 provider（上游网站）一把独立窗口——deepseek 与 chatgpt 互不影响（用户要求「各自限流」）。 */
export class ProviderRateLimiter {
  private readonly windows = new Map<string, SlidingWindowLimiter>();

  constructor(private readonly minIntervalMs: number, private readonly now: () => number = Date.now) {}

  tryAcquire(providerId: string): RateLimitDecision {
    let w = this.windows.get(providerId);
    if (!w) {
      w = new SlidingWindowLimiter(this.minIntervalMs, this.now);
      this.windows.set(providerId, w);
    }
    return w.tryAcquire();
  }
}
