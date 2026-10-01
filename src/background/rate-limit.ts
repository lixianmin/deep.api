/**
 * 上游站点请求节流（2026-10-01，feat/rate-limit）。
 *
 * 需求（用户原话）：走同一个网站（当前只有 chat.deepseek.com，日后接 ChatGPT）的请求，
 * 每秒最多一次；超过就拒绝，**哪怕是不同的 session、不同的 thread** 也一起算。
 * 动机不是省钱也不是防重复，而是反自动化检测：不要让 DeepSeek 看到脚本在并发冲击它的网页。
 *
 * 因此限流键是 provider（= 上游网站），不是 session/thread/conversation_id——按后两者分桶
 * 等于没限。
 *
 * 2026-10-01（feat/upstream-health）加抖动：原实现是确定性滑动窗口，连续放行的间隔精确
 * 等于 minIntervalMs，构成一个完美方波——而真人发消息的间隔是重尾分布。**等距脉冲本身
 * 就是机器特征**，不加抖动时「限流」在反自动化这个目标上帮了倒忙。抖动只往后延不往前推：
 * 实际间隔 ∈ [minIntervalMs, minIntervalMs + jitterMs]，限流强度只增不减。
 */
export interface RateLimitDecision {
  ok: boolean;
  /** 距下一格窗口的剩余毫秒（ok=false 时 > 0），用于写进 429 的 message。 */
  retryAfterMs: number;
}

/** 滑动窗口：两次**放行**之间的间隔必须 ≥ minIntervalMs（+ 抖动）。被拒的调用不推进窗口。 */
export class SlidingWindowLimiter {
  // -Infinity 让首次调用无条件放行（等价于「很久以前通过过」），minIntervalMs=0 时也成立。
  private lastPassAt = Number.NEGATIVE_INFINITY;
  /**
   * 上次放行时定下的窗口（含当次抖动）。
   * 存在字段里而不是每次重算：否则 rand 会在拒绝路径上被消耗，同一窗口内算出的
   * 剩余等待忽大忽小。首次调用不抖动（没有「上一次」可参考）。
   */
  private lastWindowMs: number;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    /** 抖动上界（ms）。0 = 不抖（默认，保持老行为与老测试不变）。 */
    private readonly jitterMs: number = 0,
    /** 随机源注入点：单测传固定序列，不依赖 Math.random。 */
    private readonly rand: () => number = Math.random,
  ) {
    this.lastWindowMs = this.minIntervalMs;
  }

  /** 本次放行后距下次放行的实际间隔。minIntervalMs<=0 时不抖——那是单测 seam，加抖动会误伤。 */
  private rollWindow(): number {
    if (this.minIntervalMs <= 0 || this.jitterMs <= 0) return this.minIntervalMs;
    return this.minIntervalMs + Math.round(this.rand() * this.jitterMs);
  }

  tryAcquire(): RateLimitDecision {
    const t = this.now();
    const elapsed = t - this.lastPassAt;
    if (elapsed >= this.lastWindowMs) {
      this.lastPassAt = t;
      this.lastWindowMs = this.rollWindow();
      return { ok: true, retryAfterMs: 0 };
    }
    // 拒绝时**不**更新 lastPassAt：窗口始终从上次放行起算，越拒越久的行为被刻意排除
    // （否则连续试探性请求会把正常请求挡在越来越远的未来）。
    return { ok: false, retryAfterMs: this.lastWindowMs - elapsed };
  }
}

/** 每 provider（上游网站）一把独立窗口——deepseek 与 chatgpt 互不影响（用户要求「各自限流」）。 */
export class ProviderRateLimiter {
  private readonly windows = new Map<string, SlidingWindowLimiter>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly jitterMs: number = 0,
    private readonly rand: () => number = Math.random,
  ) {}

  tryAcquire(providerId: string): RateLimitDecision {
    let w = this.windows.get(providerId);
    if (!w) {
      w = new SlidingWindowLimiter(this.minIntervalMs, this.now, this.jitterMs, this.rand);
      this.windows.set(providerId, w);
    }
    return w.tryAcquire();
  }
}
