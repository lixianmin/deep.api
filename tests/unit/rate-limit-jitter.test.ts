// 2026-10-01（feat/upstream-health）：限流抖动。
//
// 动机：SlidingWindowLimiter 是确定性滑动窗口，连续放行的间隔精确等于 minIntervalMs，
// 形成一个完美方波。真人发消息的间隔是重尾分布，等距脉冲本身就是机器特征。
// 抖动只往后延、不往前推（实际间隔 ∈ [minIntervalMs, minIntervalMs + jitterMs]），
// 保证限流强度只增不减，不会因为抖动意外放行得更快。
import { describe, it, expect } from 'vitest';
import { ProviderRateLimiter, SlidingWindowLimiter } from '../../src/background/rate-limit';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** 固定序列的伪随机源，避免用例依赖 Math.random。 */
function seqRand(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('SlidingWindowLimiter: 抖动', () => {
  it('jitterMs=0（默认）行为与改动前逐字节一致', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now);
    expect(l.tryAcquire()).toEqual({ ok: true, retryAfterMs: 0 });
    c.advance(1000);
    expect(l.tryAcquire()).toEqual({ ok: true, retryAfterMs: 0 });
  });

  it('rand()=1 时实际窗口 = minIntervalMs + jitterMs（上界）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now, 1500, seqRand([1]));
    l.tryAcquire();                       // t=0 放行，实际窗口 1000+1500=2500
    c.advance(2499);
    expect(l.tryAcquire().ok).toBe(false);
    c.advance(1);                         // t=2500
    expect(l.tryAcquire().ok).toBe(true);
  });

  it('rand()=0 时实际窗口 = minIntervalMs（下界，不因抖动变快）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now, 1500, seqRand([0]));
    l.tryAcquire();
    c.advance(1000);
    expect(l.tryAcquire().ok).toBe(true);
  });

  it('retryAfterMs 反映抖动后的真实剩余等待（含抖动，不是固定 minIntervalMs）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now, 1500, seqRand([1]));
    l.tryAcquire();                       // t=0，窗口 2500
    c.advance(1000);
    // 距上次放行 1000ms，但窗口是 2500 → 还差 1500
    expect(l.tryAcquire()).toEqual({ ok: false, retryAfterMs: 1500 });
  });

  it('被拒的调用不推进窗口（抖动后依然成立——否则连续试探会把正常请求越推越远）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now, 1500, seqRand([0.5]));   // 窗口 1750
    l.tryAcquire();                       // t=0
    c.advance(1000);
    expect(l.tryAcquire().ok).toBe(false);
    // 若被拒调用推进了窗口，这里会需要再等 750ms；正确实现下 t=1750 恰好放行
    c.advance(750);
    expect(l.tryAcquire().ok).toBe(true);
  });

  it('每次放行都重新摇一次（连续两次的间隔不同 → 不是方波）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now, 1000, seqRand([0, 1]));
    l.tryAcquire();                       // t=0，rand=0 → 窗口 1000
    c.advance(1000);
    l.tryAcquire();                       // t=1000 放行，rand=1 → 窗口 2000
    c.advance(1000);
    expect(l.tryAcquire().ok).toBe(false); // t=2000，距上次放行仅 1000，但窗口 2000
    c.advance(1000);
    expect(l.tryAcquire().ok).toBe(true);
  });

  it('minIntervalMs<=0 时抖动不生效（单测 seam：router 全量放行不能被抖动误伤）', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(0, c.now, 1500, seqRand([1]));
    expect(l.tryAcquire().ok).toBe(true);
    expect(l.tryAcquire().ok).toBe(true);
  });
});

describe('ProviderRateLimiter: 抖动透传', () => {
  it('jitterMs 传给每个 provider 自己的窗口，且 provider 之间独立', () => {
    const c = clock();
    const l = new ProviderRateLimiter(1000, c.now, 1500, seqRand([1]));   // 窗口 2500
    expect(l.tryAcquire('deepseek')).toEqual({ ok: true, retryAfterMs: 0 });
    c.advance(1000);
    expect(l.tryAcquire('chatgpt')).toEqual({ ok: true, retryAfterMs: 0 });   // 另一站点独立放行
    expect(l.tryAcquire('deepseek')).toEqual({ ok: false, retryAfterMs: 1500 });
  });

  it('默认参数不传 jitterMs 时行为与改动前一致（老调用点零影响）', () => {
    const c = clock();
    const l = new ProviderRateLimiter(1000, c.now);
    l.tryAcquire('deepseek');
    c.advance(1000);
    expect(l.tryAcquire('deepseek').ok).toBe(true);
  });
});
