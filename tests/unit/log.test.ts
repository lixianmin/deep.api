import { describe, it, expect } from 'vitest';
import { RingLog } from '../../src/background/log';

describe('RingLog', () => {
  it('keeps last 20 entries in order', () => {
    const l = new RingLog(20);
    for (let i = 0; i < 25; i++) l.push({ at: i, provider: 'deepseek', model: 'm', ok: true, ms: 1 });
    const list = l.list();
    expect(list).toHaveLength(20);
    expect(list[0]!.at).toBe(5);
    expect(list[19]!.at).toBe(24);
  });
});
