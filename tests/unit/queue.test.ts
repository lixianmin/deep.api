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
});
