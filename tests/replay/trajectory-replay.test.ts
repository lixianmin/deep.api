import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderStreamEvent, ProviderCompletion, ProviderContext } from '../../src/background/providers/adapter';
import type { ChatCompletionChunk, Message } from '../../src/shared/api-types';

// 2026-09-09（fix/trajectory-fixture）：真实用户 popup 日志 → 重放测试基建。
// 每个 entry：把用户的 LLM 真实响应结构（来自 messagesFull）做 fixture，
// 跑 router.create，断言与 popup 现场完全一致的 log 字段。
// 见 tests/fixtures/trajectories/README.md。

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

function adapterFromStub(stub: { events?: ProviderStreamEvent[] }): ProviderAdapter {
  const baseEvents = stub.events ?? [];
  const streamCompletion = async function* (_ctx: ProviderContext, _req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
    for (const e of baseEvents) yield e;
  };
  return {
    id: 'deepseek',
    auth: { loginPageUrl: '', cookieDomain: '', requiredCookies: [], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async () => ({ providerId: 'deepseek', webSessionId: 's-replay', parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion,
    models: [{ id: 'deepseek-v4-flash', provider: 'deepseek', description: 'v4-flash' }],
    resolveModel: (id: string) => id === 'deepseek-v4-flash'
      ? { modelId: id, modelType: 'default' as const, supportsImages: false, thinking: false, limitChars: 2_621_440 }
      : null,
    isRateLimited: () => false,
    isAuthExpired: () => false,
    isUnavailable: () => false,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
  };
}

function makeRouter(adapter: ProviderAdapter) {
  const now = () => Date.now();
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's-replay' }), deleteSession: async () => {}, now },
    { poolSize: 2, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 60_000, now }),
    storage: { get: async () => undefined },
    log: new RingLog(20),
    now,
    version: '0.0.0-test',
  });
  return { router, mapper };
}

type Entry = {
  label: string;
  request: {
    model: string;
    messages: Message[];
    conversation_id?: string;
    stream?: boolean;
  };
  stub: { events?: ProviderStreamEvent[] };
  expectLog: {
    action: 'rebuild' | 'incremental';
    threadFound: boolean;
    deletedOld: boolean;
    finishReason: string;
    msgsLen: number;
  };
};

function loadFixture(name: string): Entry[] {
  const path = join(__dirname, '..', 'fixtures', 'trajectories', name);
  return readFileSync(path, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l) as Entry);
}

describe('trajectory replay（fix/trajectory-fixture，2026-09-09）', () => {
  it('rebuild 路径：首次创建会话，threadFound=false', async () => {
    const entries = loadFixture('thread-persistence.jsonl');
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const e = entries[0]!;
    const { router } = makeRouter(adapterFromStub(e.stub));
    const req = {
      model: e.request.model,
      messages: e.request.messages,
      ...(e.request.conversation_id ? { conversation_id: e.request.conversation_id } : {}),
      ...((e.request.stream ?? false) ? { stream: true } : {}),
    } as Parameters<typeof router.create>[1];
    const s = await router.create('tok', req);
    for await (const _ of s as AsyncIterable<ChatCompletionChunk>) { void _; }

    const logs = router['d'].log.list();
    const entry = logs[logs.length - 1] as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();

    // 与 fixture expectLog 字段逐一断言
    expect(entry!.action).toBe(e.expectLog.action);
    expect(entry!.threadFound).toBe(e.expectLog.threadFound);
    expect(entry!.deletedOld).toBe(e.expectLog.deletedOld);
    expect(entry!.finishReason).toBe(e.expectLog.finishReason);
    expect(entry!.msgsLen).toBe(e.expectLog.msgsLen);
    // 关键不变量：webSessionId 是 adapter 创建的（'s-replay'），parentMessageId 来自 stub message_id
    expect(entry!.webSessionId).toBe('s-replay');
    expect(entry!.parentMessageId).toBe(2);
  });
});
