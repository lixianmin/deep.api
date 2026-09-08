import { describe, it, expect } from 'vitest';
import { hashMessages, renderTranscript, renderTail, limitCharsFor } from '../../src/background/transcript-renderer';
import type { Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

describe('renderTranscript', () => {
  it('returns plain text of last user message (no role template tags)', () => {
    const r = renderTranscript([m('user', '你好'), m('assistant', 'hi')]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt).toBe('你好');
    expect(r.prompt).not.toContain('user');
  });
  it('folds system into the start of the prompt', () => {
    const r = renderTranscript([m('system', 'sys指令'), m('user', 'u1')]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt).toContain('sys指令');
    expect(r.prompt.indexOf('sys指令')).toBeLessThan(r.prompt.indexOf('u1'));
  });
  it('takes last user message as prompt in multi-turn tail (history by parent_message_id)', () => {
    const r = renderTail([m('assistant', '上一次回复'), m('user', '第二轮问题')]);
    expect(r).toBe('第二轮问题');
  });
  it('uses tool message content if it is the last non-assistant message', () => {
    const r = renderTranscript([
      m('user', 'q'),
      m('assistant', '', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }),
      m('tool', 'result', { tool_call_id: 'c1' }),
    ]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt).toContain('result');
  });
});
