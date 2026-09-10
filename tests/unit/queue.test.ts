import { describe, it, expect } from 'vitest';
import { Queue, QueueTimeoutError } from '../../src/background/queue';

describe('Queue', () => {
  it('serializes per key and times out after budget', async () => {
    const q = new Queue({ timeoutMs: 50, now: () => Date.now() });
    const order: string[] = [];
    const p1 = q.runExclusive('k', async () => { order.push('a'); await new Promise(r => setTimeout(r, 10)); order.push('a2'); });
    const p2 = q.runExclusive('k', async () => { order.push('b'); });
    await p1; await p2;
    expect(order).toEqual(['a', 'a2', 'b']);
    await expect(q.runExclusive('k2', async () => { await new Promise(r => setTimeout(r, 200)); })).resolves.toBeUndefined();
  });
  it('rejects with QueueTimeoutError when key held beyond timeout', async () => {
    const q = new Queue({ timeoutMs: 20, now: () => Date.now() });
    const hold = q.runExclusive('k', async () => { await new Promise(r => setTimeout(r, 100)); });
    await expect(q.runExclusive('k', async () => {})).rejects.toThrow(QueueTimeoutError);
    await hold;
  });
  it('lets a later waiter run after the first fails', async () => {
    const q = new Queue({ timeoutMs: 50, now: () => Date.now() });
    const p1 = q.runExclusive('k', async () => { throw new Error('boom'); });
    await expect(p1).rejects.toThrow('boom');
    await expect(q.runExclusive('k', async () => {})).resolves.toBeUndefined();
  });
  // 2026-09-11（fix/queue-poolsize）：poolSize>1 时不同 key 必须真并行（spec §4.3「每 provider
  // 线程池上限 poolSize」）；旧实现只有一把全局锁，panel 调大池子不产生任何并发。
  it('runs different keys concurrently when concurrency > 1', async () => {
    const q = new Queue({ timeoutMs: 500, concurrency: 2 });
    const order: string[] = [];
    const p1 = q.runExclusive('k1', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 50)); order.push('a-end'); });
    const p2 = q.runExclusive('k2', async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 5)); order.push('b-end'); });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });
  it('still serializes the same key when concurrency > 1', async () => {
    const q = new Queue({ timeoutMs: 500, concurrency: 2 });
    const order: string[] = [];
    const p1 = q.runExclusive('k', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end'); });
    const p2 = q.runExclusive('k', async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 5)); order.push('b-end'); });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });
  it('queues the third request until a slot frees at the limit', async () => {
    const q = new Queue({ timeoutMs: 500, concurrency: 2 });
    const order: string[] = [];
    const mk = (key: string, ms: number) => q.runExclusive(key, async () => {
      order.push(`${key}-start`); await new Promise(r => setTimeout(r, ms)); order.push(`${key}-end`);
    });
    await Promise.all([mk('k1', 50), mk('k2', 5), mk('k3', 5)]);
    // k3 必须等 k2 释放的槽位（并发上限 2），但与仍在跑的 k1 并行 —— 而非等所有请求串行跑完。
    expect(order.indexOf('k3-start')).toBeGreaterThan(order.indexOf('k2-end'));
    expect(order.indexOf('k3-start')).toBeLessThan(order.indexOf('k1-end'));
  });
  it('setConcurrency(1) degrades back to strict serialization and drains waiters', async () => {
    const q = new Queue({ timeoutMs: 500, concurrency: 2 });
    const order: string[] = [];
    const p1 = q.runExclusive('k1', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 40)); order.push('a-end'); });
    const p2 = q.runExclusive('k2', async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 40)); order.push('b-end'); });
    const p3 = q.runExclusive('k3', async () => { order.push('c-start'); });
    q.setConcurrency(1);
    await Promise.all([p1, p2, p3]);
    expect(order.indexOf('c-start')).toBeGreaterThan(order.indexOf('b-end'));
  });
});
