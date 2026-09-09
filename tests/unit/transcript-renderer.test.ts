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

// 2026-09-09（fix/full-tool-prompt）：spice agent loop 第二轮 messages =
// [system, user(提问), asst(tool_calls), tool(结果1), tool(结果2)]。
// 旧实现渲染 prompt 只取「最后一条 user/tool」→ 只有 sketch.ino 的空代码，
// diagram.json 结果丢失；模型误以为「用户新贴了空 sketch」，第二轮重读文件
// → spice「连续两轮相同工具调用」判无进展停止。
describe('renderTranscript with tool results (fix/full-tool-prompt)', () => {
  it('fail-to-pass: 多工具结果全部进 prompt，标注工具名，保留用户提问原文', () => {
    const r = renderTranscript([
      m('user', '帮我修改电路图加5个LED'),
      m('assistant', '', { tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"diagram.json"}' } },
        { id: 'c2', type: 'function', function: { name: 'Read', arguments: '{"path":"sketch.ino"}' } },
      ] }),
      m('tool', '{"version":1,"parts":[]}', { tool_call_id: 'c1' }),
      m('tool', 'void setup() {}', { tool_call_id: 'c2' }),
    ]);
    if (!r.ok) throw new Error('expected ok');
    // 用户提问原文必须在（模型需要知道任务上下文）
    expect(r.prompt).toContain('帮我修改电路图加5个LED');
    // 两个工具结果都要在
    expect(r.prompt).toContain('{"version":1,"parts":[]}');
    expect(r.prompt).toContain('void setup() {}');
    // 每个工具结果都有可辨识的标注（模型才明白这是"已读结果"而不是"用户新贴的代码"）
    expect(r.prompt).toMatch(/【工具[^】]*Read[^】]*】/);
  });
});
