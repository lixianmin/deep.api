// 2026-10-01（feat/upstream-health）：上游 429 重试收敛。
//
// 改动前（router.ts streamWithRetry）：429 后重试 3 次，退避 500ms×2^n（500/1000/2000），
// 每次重试都是全新的 pow challenge + completion，全程持队列锁。DeepSeek 说「慢点」，
// 我们回它 4 个请求 / 3.5 秒——这是唯一一处主动顶撞限流阈值的行为。
//
// 改动后：只重试 1 次，且退避 ≥ 5s。理由：429 已是上游明确的拒绝信号，
// 连续重试只会把「被限流」升级成「持续冲击」；一次长退避的重试既能覆盖瞬时抖动，
// 又不会在阈值上堆请求。
import { describe, it, expect, vi } from 'vitest';
import { Router, RATE_LIMIT_RETRY_ATTEMPTS, RATE_LIMIT_RETRY_BASE_MS } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { Message } from '../../src/shared/api-types';

const m = (role: Message['role'], content: string): Message => ({ role, content });

function stubAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  let seq = 0;
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: `s${++seq}`, parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { kind: 'message_id', id: 1 };
      yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
    },
    models: [{ id: 'deepseek-flash', provider: 'deepseek', description: 'flash' }],
    resolveModel: (id: string) => id === 'deepseek-flash'
      ? { modelId: id, modelType: 'default' as const, supportsImages: false, thinking: false, limitChars: 2_621_440 }
      : null,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    ...over,
  };
  return base;
}

function makeRouter(adapter: ProviderAdapter) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 5, ttlMs: 60_000 },
  );
  const router = new Router({
    registry: { deepseek: adapter },
    mapper,
    queue: new Queue({ timeoutMs: 5_000, now }),
    storage: { get: async () => undefined },
    log: new RingLog(50),
    now,
    version: '0.0.0-test',
    minRequestIntervalMs: 0,     // 关掉入口限流：本文件只测 429 重试
  });
  return { router, mapper };
}

const TOKEN = 'tok';
const REQ = { model: 'deepseek-flash', messages: [m('user', 'hi')] };

describe('上游 429 重试收敛', () => {
  it('常量值锁定：只重试 1 次、退避 ≥ 5s（改动前是 3 次 / 500ms 起手）', () => {
    expect(RATE_LIMIT_RETRY_ATTEMPTS).toBe(1);
    expect(RATE_LIMIT_RETRY_BASE_MS).toBeGreaterThanOrEqual(5000);
  });

  it('429 一次后重试成功 → 总共 2 次上游调用（第一次 429 + 一次重试）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          if (calls === 1) throw { status: 429 };
          yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
        },
      });
      const { router } = makeRouter(a);
      const p = router.create(TOKEN, { ...REQ });
      // 推进足够时间覆盖退避：改动前 500ms 就够，新逻辑需要 ≥5000ms
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_BASE_MS + 1000);
      const res: any = await p;
      expect(calls).toBe(2);
      expect(res.choices[0].message.content).toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('连续 429 → 只重试 1 次就放弃（总 2 次调用），错误如实抛给调用方', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          throw { status: 429 };
        },
      });
      const { router } = makeRouter(a);
      const p = router.create(TOKEN, { ...REQ });
      const settled = p.then(() => 'resolved', (e) => e);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_BASE_MS * 4 + 1000);
      const outcome: any = await settled;
      expect(calls).toBe(2);                              // 改动前会是 4 次
      expect(outcome.status).toBe(429);
      expect(outcome.error?.error?.code).toBe('rate_limited');
    } finally { vi.useRealTimers(); }
  });

  it('退避期间不发出任何上游请求（重试是「等够再发」，不是「立刻再发」）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          if (calls === 1) throw { status: 429 };
          yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
        },
      });
      const { router } = makeRouter(a);
      const p = router.create(TOKEN, { ...REQ });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      // 改动前的起手退避是 500ms；新逻辑在 1000ms 时必须还没重试
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_BASE_MS);
      const res: any = await p;
      expect(calls).toBe(2);
      expect(res.choices[0].message.content).toBe('ok');
    } finally { vi.useRealTimers(); }
  });

  it('非 429 错误不重试（改动前也是：只对 isRateLimited 重试，此用例防回归）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          throw { status: 500 };
        },
      });
      const { router } = makeRouter(a);
      const p = router.create(TOKEN, { ...REQ });
      const settled = p.then(() => 'resolved', (e) => e);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_BASE_MS * 3);
      const outcome: any = await settled;
      expect(calls).toBe(1);
      expect(outcome.status).toBeGreaterThanOrEqual(500);
    } finally { vi.useRealTimers(); }
  });

  it('已产出内容后遇 429 不重试（重试只在零内容时进行，避免重复内容）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({
        streamCompletion: async function* () {
          calls++;
          yield { kind: 'content_delta', content: 'partial' };
          throw { status: 429 };
        },
      });
      const { router } = makeRouter(a);
      const p = router.create(TOKEN, { ...REQ });
      const settled = p.then(() => 'resolved', (e) => e);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_BASE_MS * 3);
      await settled;
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
