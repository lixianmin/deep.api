import { describe, it, expect, vi } from 'vitest';
import { SessionMapper } from '../../src/background/session-mapper';
import type { Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });
const mk = () => {
  const deps = { createSession: vi.fn(async () => ({ webSessionId: `s${(deps as any).createSession.mock.calls.length}` })), deleteSession: vi.fn(async () => {}), now: () => 1000 };
  return { mapper: new SessionMapper(deps, { poolSize: 2, ttlMs: 60_000 }), deps };
};

describe('SessionMapper', () => {
  it('increments when mirror is prefix of messages', async () => {
    const { mapper } = mk();
    const d1 = mapper.decide('deepseek', [m('user', 'hi')]);
    expect(d1.action).toBe('rebuild');
    const t = mapper.register('deepseek', mapper.nextAutoConversationId(), 's1', [m('user', 'hi')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'hi')], 's1', 10);
    const d2 = mapper.decide('deepseek', [m('user', 'hi'), m('user', 'next')]);
    expect(d2.action).toBe('incremental');
    if (d2.action === 'incremental') { expect(d2.thread.webSessionId).toBe('s1'); expect(d2.tail).toEqual([m('user', 'next')]); }
  });
  it('rebuilds on rewind (prefix shorter than mirror)', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a'), m('assistant', 'b')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'a'), m('assistant', 'b')], 's1', 5);
    const d = mapper.decide('deepseek', [m('user', 'a'), m('user', 'new')]);
    expect(d.action).toBe('rebuild');
  });
  it('rebuilds on exact replay (tail empty) and returns the matched thread', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user', 'a')]);
    expect(d.action).toBe('rebuild');
    if (d.action === 'rebuild') expect(d.existing?.webSessionId).toBe('s1');
  });
  it('tail starting with non-user triggers rebuild', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user', 'a'), m('assistant', 'auto')]);
    expect(d.action).toBe('rebuild');
    if (d.action === 'rebuild') expect(d.existing?.webSessionId).toBe('s1');
  });
  it('named thread mismatch rebuilds and keeps key', async () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'conv-1', 's1', [m('user', 'a')]);
    mapper.commit('deepseek', 'conv-1', [m('user', 'a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user', 'changed')], 'conv-1');
    expect(d.action).toBe('rebuild');
    if (d.action === 'rebuild') { expect(d.existing?.webSessionId).toBe('s1'); }
  });
  it('named thread continues incrementally on appended user turn', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'conv-1', 's1', [m('user', 'a'), m('assistant', 'b')]);
    mapper.commit('deepseek', 'conv-1', [m('user', 'a'), m('assistant', 'b')], 's1', 7);
    const d = mapper.decide('deepseek', [m('user', 'a'), m('assistant', 'b'), m('user', 'next')], 'conv-1');
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') expect(d.tail).toEqual([m('user', 'next')]);
  });
  it('evicts LRU on register over poolSize and expires idle threads', async () => {
    const { mapper, deps } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    mapper.register('deepseek', 'auto:2', 's2', [m('user', 'b')]);
    mapper.register('deepseek', 'auto:3', 's3', [m('user', 'c')]);  // 淘汰 s1
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
    const stats = mapper.stats();
    expect(stats.threads).toBe(2);
    deps.now = () => 1000 + 61_000;
    await mapper.evictExpired('deepseek');
    expect(mapper.stats().threads).toBe(0);
  });
  it('fail() destroys the thread', async () => {
    const { mapper, deps } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    await mapper.fail('deepseek', t.conversationId);
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
    expect(mapper.stats().threads).toBe(0);
  });
  it('incremental allows tool-head tail (tool-loop continuation)', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a1'), m('assistant', '', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] })]);
    mapper.commit('deepseek', 'auto:1', [m('user', 'a1'), m('assistant', '', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] })], 's1', 5);
    const d = mapper.decide('deepseek', [
      m('user', 'a1'),
      m('assistant', '', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }),
      m('tool', 'result', { tool_call_id: 'c1' }),
      m('user', 'a2'),
    ]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') {
      expect(d.thread.webSessionId).toBe('s1');
      expect(d.tail).toEqual([m('tool', 'result', { tool_call_id: 'c1' }), m('user', 'a2')]);
    }
  });
  it('assistant-head tail still rebuilds (only user/tool allowed as tail head)', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a'), m('assistant', 'b')]);
    mapper.commit('deepseek', 'auto:1', [m('user', 'a'), m('assistant', 'b')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user', 'a'), m('assistant', 'b'), m('assistant', 'next')]);
    expect(d.action).toBe('rebuild');
  });
  it('returns error decision on empty messages', () => {
    const { mapper } = mk();
    expect(mapper.decide('deepseek', []).action).toBe('error');
  });
});
  it('increments when mirror includes assistant reply and client sends full history (multi-turn regression)', () => {
    const { mapper } = mk();
    // 第一轮：注册 + commit（mirror = [user, assistant]）
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'hi'), m('assistant', 'hello!')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'hi'), m('assistant', 'hello!')], 's1', 10);
    // 第二轮：客户端传全量历史 [user, assistant, user 新问题]
    const d = mapper.decide('deepseek', [m('user', 'hi'), m('assistant', 'hello!'), m('user', 'what name?')]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') {
      expect(d.thread.webSessionId).toBe('s1');                 // 复用同一 DeepSeek 会话
      expect(d.tail).toEqual([m('user', 'what name?')]);        // tail 只含新问题
    }
  });

  it('sameMsg normalizes null vs empty string for assistant content (tool_calls scenario) — v0.1.43 fix', () => {
    // mirror 存的是 router finalize 的 ''（tool_calls 模式下 agg.content 为空字符串）
    // demo 客户端发的是 OpenAI 风格 null（tool_calls 模式标准）
    // 两者应被视为相同，否则 tool-loop 第二轮会误判 rebuild → 开新 session
    const { mapper } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [
      m('user', '北京天气如何？'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    ]);
    mapper.commit('deepseek', 'auto:1', [
      m('user', '北京天气如何？'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    ], 's1', 5);
    // 第二轮：demo 客户端传 content=null（OpenAI 风格）
    const d = mapper.decide('deepseek', [
      m('user', '北京天气如何？'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'w1', content: '晴 26°C 微风' },
      m('user', '那明天呢？'),
    ]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') {
      expect(d.thread.webSessionId).toBe('s1');
      expect(d.tail.length).toBe(2);  // tool + user
    }
  });
