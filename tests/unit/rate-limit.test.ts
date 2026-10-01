import { describe, it, expect } from 'vitest';
import { ProviderRateLimiter, SlidingWindowLimiter } from '../../src/background/rate-limit';

/** 可推进的假时钟：限流是纯时间函数，不必真的等 1s。 */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('SlidingWindowLimiter', () => {
  it('passes the first call and rejects the second inside the window', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now);
    expect(l.tryAcquire()).toEqual({ ok: true, retryAfterMs: 0 });
    c.advance(999);
    // 剩余等待 = 1000 - 999 = 1ms（用于给调用方写进 429 message）
    expect(l.tryAcquire()).toEqual({ ok: false, retryAfterMs: 1 });
  });

  it('passes exactly at the interval boundary', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now);
    l.tryAcquire();
    c.advance(1000);
    expect(l.tryAcquire()).toEqual({ ok: true, retryAfterMs: 0 });
  });

  it('a rejected call does not move the window (wait is measured from the last pass)', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(1000, c.now);
    l.tryAcquire();               // t=0 放行
    c.advance(999);
    expect(l.tryAcquire().ok).toBe(false);   // 拒绝，不推进窗口
    c.advance(1);                 // t=1000：距上次**放行**刚好 1000ms
    expect(l.tryAcquire()).toEqual({ ok: true, retryAfterMs: 0 });
  });

  it('minIntervalMs <= 0 disables the limiter (测试 seam：router 单测全量放行)', () => {
    const c = clock();
    const l = new SlidingWindowLimiter(0, c.now);
    expect(l.tryAcquire().ok).toBe(true);
    expect(l.tryAcquire().ok).toBe(true);
  });
});

describe('ProviderRateLimiter', () => {
  // 2026-10-01（feat/rate-limit）：用户要求「各自每一个网站的地址限流为一秒一次」——
  // deepseek 与日后的 chatgpt 各有一把窗口，互不影响。
  it('keys the window per provider: one provider hitting the limit does not block another', () => {
    const c = clock();
    const l = new ProviderRateLimiter(1000, c.now);
    expect(l.tryAcquire('deepseek')).toEqual({ ok: true, retryAfterMs: 0 });
    expect(l.tryAcquire('chatgpt')).toEqual({ ok: true, retryAfterMs: 0 });   // 另一站点不受影响
    expect(l.tryAcquire('deepseek')).toEqual({ ok: false, retryAfterMs: 1000 });
  });

  it('tracks windows independently per provider', () => {
    const c = clock();
    const l = new ProviderRateLimiter(1000, c.now);
    l.tryAcquire('deepseek');       // deepseek: t=0
    c.advance(600);
    l.tryAcquire('chatgpt');        // chatgpt: t=600
    c.advance(400);                 // t=1000
    expect(l.tryAcquire('deepseek').ok).toBe(true);    // 距 0 已 1000ms
    expect(l.tryAcquire('chatgpt')).toEqual({ ok: false, retryAfterMs: 600 });   // 距 600 仅 400ms
  });
});
