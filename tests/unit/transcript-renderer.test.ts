import { describe, it, expect } from 'vitest';
import { hashMessages, renderTranscript, renderTail, limitCharsFor } from '../../src/background/transcript-renderer';
import type { Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

describe('renderTranscript', () => {
  it('merges adjacent same-role messages', () => {
    const r = renderTranscript([m('user', 'a'), m('user', 'b'), m('assistant', 'c')]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt.match(/a\s*\n\s*b/g)?.length ?? 0).toBeGreaterThan(0);
    expect(r.prompt.indexOf('c')).toBeGreaterThan(-1);
  });
  it('folds system into first block, keeps role order', () => {
    const r = renderTranscript([m('system', 'sys'), m('user', 'u1'), m('assistant', 'a1')]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt.indexOf('sys')).toBeLessThan(r.prompt.indexOf('u1'));
    expect(r.prompt.indexOf('u1')).toBeLessThan(r.prompt.indexOf('a1'));
  });
  it('renders tool messages and tool_calls', () => {
    const r = renderTranscript([
      m('user', 'q'),
      m('assistant', '', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }),
      m('tool', 'result', { tool_call_id: 'c1' }),
    ]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt).toContain('c1');
    expect(r.prompt).toContain('result');
  });
});

describe('hashMessages', () => {
  it('is stable and distinct', async () => {
    const a = await hashMessages([m('user', 'hi')]);
    const b = await hashMessages([m('user', 'hi')]);
    const c = await hashMessages([m('user', 'ho')]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('renderTail', () => {
  it('renders multi-turn tail with role markers', () => {
    const t = renderTail([m('tool', 'r', { tool_call_id: 'c2' }), m('user', 'next')]);
    expect(t).toContain('c2');
    expect(t).toContain('next');
  });
});

describe('limitCharsFor', () => {
  it('exports model char limits', () => {
    expect(limitCharsFor('expert')).toBe(163_840);
    expect(limitCharsFor('default')).toBe(2_621_440);
  });
});
