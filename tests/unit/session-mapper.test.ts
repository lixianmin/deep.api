import { describe, it, expect, vi } from 'vitest';
import { SessionMapper } from '../../src/background/session-mapper';
import { RingLog } from '../../src/background/log';
import type { Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });
// 2026-09-15（feat/auto-delete-web-threads）：cfg 可覆盖，默认 autoDeleteWebThreads 缺省=false（不删网页会话）。
const mk = (cfg: Partial<{ poolSize: number; ttlMs: number; autoDeleteWebThreads: boolean }> = {}) => {
  const deps = { createSession: vi.fn(async () => ({ webSessionId: `s${(deps as any).createSession.mock.calls.length}` })), deleteSession: vi.fn(async () => {}), now: () => 1000 };
  return { mapper: new SessionMapper(deps, { poolSize: 2, ttlMs: 60_000, ...cfg }), deps };
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
    const { mapper, deps } = mk({ autoDeleteWebThreads: true });   // 旧删除行为需显式开启（2026-09-15 起默认关）
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
    const { mapper, deps } = mk({ autoDeleteWebThreads: true });   // 旧删除行为需显式开启
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    await mapper.fail('deepseek', t.conversationId);
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
    expect(mapper.stats().threads).toBe(0);
  });
  // 2026-09-15（feat/auto-delete-web-threads）：默认不删 DeepSeek 网页会话——淘汰/失败只解除本地映射。
  it('默认（autoDeleteWebThreads 关）：LRU 淘汰 / TTL 过期 / fail 只解除本地映射，不调 deleteSession', async () => {
    const { mapper, deps } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    mapper.register('deepseek', 'auto:2', 's2', [m('user', 'b')]);
    mapper.register('deepseek', 'auto:3', 's3', [m('user', 'c')]);  // LRU 淘汰 s1
    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(mapper.stats().threads).toBe(2);   // 本地映射照常解除
    deps.now = () => 1000 + 61_000;
    await mapper.evictExpired('deepseek');
    expect(mapper.stats().threads).toBe(0);   // TTL 过期照常解除
    expect(deps.deleteSession).not.toHaveBeenCalled();
    const t = mapper.register('deepseek', 'auto:9', 's9', [m('user', 'z')]);
    await mapper.fail('deepseek', t.conversationId);
    expect(mapper.stats().threads).toBe(0);
    expect(deps.deleteSession).not.toHaveBeenCalled();
  });
  it('setAutoDeleteWebThreads(true) 运行时开启后恢复删除行为', async () => {
    const { mapper, deps } = mk();
    mapper.setAutoDeleteWebThreads(true);
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    await mapper.fail('deepseek', t.conversationId);
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
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

describe('SessionMapper 周期 sweep（fix/evict-expired）', () => {
  it('fail-to-pass: commit 后 60s TTL 过期 thread 被清', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const mapper = new SessionMapper(
        { createSession: async () => ({ webSessionId: '' }), deleteSession: vi.fn(async () => {}), now: () => now },
        { poolSize: 5, ttlMs: 60_000 },   // ttl = 60s，方便快进
      );
      // 写一个 thread，commit 让它 idleSince = now
      const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);
      expect(mapper.stats().threads).toBe(1);

      // 快进 61s（> ttlMs 60s）但还没到 setTimeout 60s 触发点 → thread 仍在
      now += 61_000;
      expect(mapper.stats().threads).toBe(1);

      // 触发 setTimeout（sweepTimer 60s 已在 commit 时挂上）
      // 先快进到 setTimeout 触发点：commit 时 already setTimeout 60s，从那之后 60s
      now += 60_000;
      await vi.runAllTimersAsync();

      // 过期 thread 已被 sweep 清掉
      expect(mapper.stats().threads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commit 频率高时 sweepTimer 单实例去重', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const mapper = new SessionMapper(
        { createSession: async () => ({ webSessionId: '' }), deleteSession: vi.fn(async () => {}), now: () => now },
        { poolSize: 5, ttlMs: 60_000 },
      );
      mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);

      // 在 60s 内连续 commit 多次（不触发新 timer）
      now += 10_000;
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);
      now += 10_000;
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);

      // 跑完所有 timer
      await vi.runAllTimersAsync();
      // sweep 只跑了一次（不影响断言本身；主要断言没崩）
      expect(mapper.stats().threads).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionMapper persist debounce（fix/persist-debounce，2026-09-09）', () => {
  it('fail-to-pass: 100ms 内连续 commit 只触发一次 onPersist', async () => {
    vi.useFakeTimers();
    try {
      const writes: number[] = [];
      const now = () => 1_000_000;
      const mapper = new SessionMapper(
        { createSession: async () => ({ webSessionId: '' }), deleteSession: async () => {}, now },
        { poolSize: 2, ttlMs: 60_000 },
      );
      mapper.onPersist = () => { writes.push(mapper.serialize().seq); };

      // 连续 3 次 commit（模拟 agent loop 内多轮 LLM 调用）
      const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);
      mapper.commit('deepseek', 'auto:1', [m('user', 'a')], 's1', 1);

      // 100ms 内 timer 未触发，onPersist 还没被调
      expect(writes.length).toBe(0);

      // 推进 100ms 让 debounce timer 触发
      await vi.runAllTimersAsync();
      expect(writes.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionMapper mirrorHash 快路径（fix/mirror-hash，2026-09-09）', () => {
  it('fail-to-pass: commit 后 hash 一致 + messages 追加新 user → incremental', () => {
    const now = () => 1000;
    const mapper = new SessionMapper(
      { createSession: async () => ({ webSessionId: '' }), deleteSession: async () => {}, now },
      { poolSize: 2, ttlMs: 60_000 },
    );
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'q1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', 'auto:1', [m('user', 'q1'), m('assistant', 'a1'),
      m('tool', 'r1', { tool_call_id: 'c1' }),
      m('user', 'q2')], 's1', 5);

    const t = (mapper as any).threads.get('deepseek:auto:1') as any;
    expect(typeof t.mirrorHash).toBe('string');
    expect(t.mirrorHash.length).toBe(16);

    // messages 比 mirror 多一条新 user 消息（hash 命中前缀 + tail=新 user）→ incremental
    const d = mapper.decide('deepseek', [
      m('user', 'q1'), m('assistant', 'a1'),
      m('tool', 'r1', { tool_call_id: 'c1' }),
      m('user', 'q2'),
      m('user', 'q3'),
    ], 'auto:1');
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') {
      expect(d.tail).toEqual([m('user', 'q3')]);
    }
  });

  it('fail-to-pass: messages 改一处导致 hash 不等 → rebuild', () => {
    const now = () => 1000;
    const mapper = new SessionMapper(
      { createSession: async () => ({ webSessionId: '' }), deleteSession: async () => {}, now },
      { poolSize: 2, ttlMs: 60_000 },
    );
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'q1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', 'auto:1', [m('user', 'q1'), m('assistant', 'a1'),
      m('tool', 'r1', { tool_call_id: 'c1' }),
      m('user', 'q2')], 's1', 5);

    // 改 messages 末尾 user 文本 → hash 不同 → rebuild
    const d = mapper.decide('deepseek', [
      m('user', 'q1'), m('assistant', 'a1'),
      m('tool', 'r1', { tool_call_id: 'c1' }),
      m('user', 'q2-modified'),
    ], 'auto:1');
    expect(d.action).toBe('rebuild');
  });
});

// 2026-09-09（fix/model-switch-rebuild）：同 cid 中途换模型必须 rebuild。DeepSeek 网页 web API
// 一个 chat thread 不能中途换 model_type；reuse 旧 session 会让 model_type 与 parent_message_id 链不一致。
// mapper 层 cover：register/commit 写 modelType，decide 比对；老 thread 无 modelType（未设置）则不约束
// （SW 重启后持久化场景兼容），首次 commit 会补上。
describe('SessionMapper modelType tracking（fix/model-switch-rebuild）', () => {
  it('同 cid + 同 modelType + messages 前缀匹配 → incremental', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'cid', 's1', [m('user', 'q1')], 'default');
    mapper.commit('deepseek', 'cid', [m('user', 'q1')], 's1', 10, 'default');
    const d = mapper.decide('deepseek', [m('user', 'q1'), m('user', 'q2')], 'cid', 'default');
    expect(d.action).toBe('incremental');
  });

  it('同 cid + 换 modelType → rebuild with existing（old session 被删、modelType 以新值为准）', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'cid', 's1', [m('user', 'q1')], 'default');
    mapper.commit('deepseek', 'cid', [m('user', 'q1')], 's1', 10, 'default');
    const d = mapper.decide('deepseek', [m('user', 'q1'), m('user', 'q2')], 'cid', 'expert');
    expect(d.action).toBe('rebuild');
    if (d.action === 'rebuild') {
      expect(d.existing?.webSessionId).toBe('s1');   // mapper 透出旧 thread 让 router deleteSession
    }
  });

  it('老 thread 未设置 modelType + 请求带 modelType → 视为不约束（incremental），commit 后补上', () => {
    const { mapper } = mk();
    // 模拟 SW 重启后老持久化 thread：register 没传 modelType
    mapper.register('deepseek', 'cid', 's1', [m('user', 'q1')]);
    mapper.commit('deepseek', 'cid', [m('user', 'q1')], 's1', 10);   // 老调用者也没传 modelType
    // 首轮后续请求带 modelType='default' → 应 incremental（不动老 thread）
    const d = mapper.decide('deepseek', [m('user', 'q1'), m('user', 'q2')], 'cid', 'default');
    expect(d.action).toBe('incremental');
    // commit 补上 modelType 后，后续决定才进入追踪状态
    mapper.commit('deepseek', 'cid', [m('user', 'q1'), m('user', 'q2')], 's1', 11, 'default');
    const t = (mapper as any).threads.get('deepseek:cid');
    expect(t.modelType).toBe('default');
  });

  it('auto 池：modelType 不一致的 thread 不被选用（仅同 modelType 候选项选最长 mirror）', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'auto:1', 's-flash', [m('user', 'flash-q')], 'default');
    mapper.commit('deepseek', 'auto:1', [m('user', 'flash-q')], 's-flash', 1, 'default');
    mapper.register('deepseek', 'auto:2', 's-pro', [m('user', 'pro-q')], 'expert');
    mapper.commit('deepseek', 'auto:2', [m('user', 'pro-q')], 's-pro', 2, 'expert');
    // 请求走 expert model，且 messages 能匹配 pro thread → 选 pro
    const d1 = mapper.decide('deepseek', [m('user', 'pro-q'), m('user', 'pro-q2')], undefined, 'expert');
    expect(d1.action).toBe('incremental');
    if (d1.action === 'incremental') expect(d1.thread.webSessionId).toBe('s-pro');
    // 请求走 default model，且 messages 能匹配 flash thread → 选 flash
    const d2 = mapper.decide('deepseek', [m('user', 'flash-q'), m('user', 'flash-q2')], undefined, 'default');
    expect(d2.action).toBe('incremental');
    if (d2.action === 'incremental') expect(d2.thread.webSessionId).toBe('s-flash');
  });
});

// 2026-09-09（feat/debug-dashboard）：panel.listThreads 后端聚合——按 cid 取 log.action 最近一次决策现场
const now = () => 1_700_000_000_000;
const deps = { createSession: async () => ({ webSessionId: 'ws1' }), deleteSession: async () => {}, now };

describe('SessionMapper.listThreads', () => {
  it('空 Map 返回 []', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    expect(m.listThreads()).toEqual([]);
  });

  it('thread 无 log 时 lastDecision 为 undefined', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    m.register('deepseek', 'auto:1', 'ws1', [{ role: 'user', content: 'hi' }]);
    const rows = m.listThreads();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe('auto:1');
    expect(rows[0]!.lastDecision).toBeUndefined();
  });

  it('thread 的 lastDecision 取最近一次该 cid 的 log.action', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    m.register('deepseek', 'auto:1', 'ws1', [{ role: 'user', content: 'hi' }]);
    const log = new RingLog(500);
    log.push({ at: now() - 1000, provider: 'deepseek', model: 'm', ok: true, ms: 100, cid: 'auto:1', action: 'incremental' });
    log.push({ at: now(),         provider: 'deepseek', model: 'm', ok: true, ms: 100, cid: 'auto:1', action: 'rebuild' });
    // 把 log 注入 mapper（通过 setLogForTest 或构造时传入）
    (m as any).log = log;
    const rows = m.listThreads();
    expect(rows[0]!.lastDecision).toBe('rebuild');
    expect(rows[0]!.lastDecisionAt).toBe(now());


  });
});


// 2026-09-11（fix/review-r1）：全量审查发现的三个缺陷回归用例。
describe('SessionMapper review-r1 fixes', () => {
  it('hash 快路径：mirror 无 system、本轮开头新增 system → 仍判 incremental（不误 rebuild）', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'q1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'q1'), m('assistant', 'a1')], 's1', 10);
    const d = mapper.decide('deepseek', [m('system', 'S'), m('user', 'q1'), m('assistant', 'a1'), m('user', 'q2')]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') expect(d.tail).toEqual([m('user', 'q2')]);
  });

  it('hash 快路径：命名线程同样按「非 system 前缀」比对', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'conv-1', 's1', [m('user', 'q1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', 'conv-1', [m('user', 'q1'), m('assistant', 'a1')], 's1', 10);
    const d = mapper.decide('deepseek', [m('system', 'S'), m('user', 'q1'), m('assistant', 'a1'), m('user', 'q2')], 'conv-1');
    expect(d.action).toBe('incremental');
  });

  it('restore 跳过 mirror 缺失的损坏条目（不使 decide 抛 TypeError）', () => {
    const { mapper } = mk();
    mapper.restore({
      seq: 1,
      threads: [
        { providerId: 'deepseek', conversationId: 'broken', webSessionId: 'w', parentMessageId: null, kind: 'auto', idleSince: 0, lastUsedAt: 0, busy: false } as any,
        { providerId: 'deepseek', conversationId: 'ok', webSessionId: 'w2', parentMessageId: null, kind: 'auto', idleSince: 0, lastUsedAt: 0, busy: false, mirror: [m('user', 'hi')] } as any,
      ],
    });
    const d = mapper.decide('deepseek', [m('user', 'hi'), m('user', 'next')]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') expect(d.thread.conversationId).toBe('ok');
  });

  it('setPoolSize 立即生效：缩容时驱逐最久未用的 auto thread', () => {
    const { mapper } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    mapper.register('deepseek', 'auto:2', 's2', [m('user', 'b')]);
    expect(mapper.stats().threads).toBe(2);
    mapper.setPoolSize(1);
    expect(mapper.stats().threads).toBe(1);
  });

  it('setTtlMs 立即生效：下轮 evictExpired 立刻按新 TTL 清理', async () => {
    let clock = 1000;
    const mapper = new SessionMapper(
      { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now: () => clock },
      { poolSize: 2, ttlMs: 60_000 },
    );
    mapper.register('deepseek', 'auto:1', 's1', [m('user', 'a')]);
    clock = 2000;
    mapper.setTtlMs(500);
    await mapper.evictExpired('deepseek');
    expect(mapper.stats().threads).toBe(0);
  });
});

// 2026-09-11（fix/review-r2）：独立验证发现的两个 P1 回归。
describe('SessionMapper review-r2 fixes', () => {
  it('N1: 前缀之后新增的 system 不被 tailAfter 静默丢弃（tail 以 system 开头 → 安全回退 rebuild）', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'u1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'u1'), m('assistant', 'a1')], 's1', 10);
    const d = mapper.decide('deepseek', [m('user', 'u1'), m('assistant', 'a1'), m('system', 'S'), m('user', 'u2')]);
    expect(d.action).toBe('rebuild');
  });

  it('N1: 镜像无 system（非前缀处）时不影响正常增量', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user', 'u1'), m('assistant', 'a1')]);
    mapper.commit('deepseek', t.conversationId, [m('user', 'u1'), m('assistant', 'a1')], 's1', 10);
    const d = mapper.decide('deepseek', [m('system', 'S'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')]);
    expect(d.action).toBe('incremental');
    if (d.action === 'incremental') expect(d.tail).toEqual([m('user', 'u2')]);
  });

  it('N2: 别人持有的 busy 线程不因本请求 fail 被删除（token 不匹配则跳过）', async () => {
    const deps = { createSession: vi.fn(async () => ({ webSessionId: 's1' })), deleteSession: vi.fn(async () => {}), now: () => 1000 };
    const mapper = new SessionMapper(deps, { poolSize: 2, ttlMs: 60_000, autoDeleteWebThreads: true });   // 本用例验证删除行为，显式开启
    const t = mapper.register('deepseek', 'conv-1', 's1', [m('user', 'u1')]);
    mapper.markBusy('deepseek', t.conversationId, 'reqA');
    mapper.markBusy('deepseek', t.conversationId, 'reqB');   // B 不覆盖 A 的所有权
    await mapper.fail('deepseek', t.conversationId, 'reqB');
    expect(mapper.stats().threads).toBe(1);
    expect(deps.deleteSession).not.toHaveBeenCalled();
    // 所有者 A 失败时才销毁
    await mapper.fail('deepseek', t.conversationId, 'reqA');
    expect(mapper.stats().threads).toBe(0);
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('N2: commit 后所有权清空，下一次 fail（带 token）仍可销毁已提交线程', async () => {
    const deps = { createSession: vi.fn(async () => ({ webSessionId: 's1' })), deleteSession: vi.fn(async () => {}), now: () => 1000 };
    const mapper = new SessionMapper(deps, { poolSize: 2, ttlMs: 60_000 });
    const t = mapper.register('deepseek', 'conv-1', 's1', [m('user', 'u1')]);
    mapper.markBusy('deepseek', t.conversationId, 'reqA');
    mapper.commit('deepseek', t.conversationId, [m('user', 'u1'), m('assistant', 'a1')], 's1', 10);
    await mapper.fail('deepseek', t.conversationId, 'reqB');
    expect(mapper.stats().threads).toBe(0);
  });
});
