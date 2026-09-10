import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ResolvedModel, ProviderStreamEvent, ProviderSession } from '../../src/background/providers/adapter';

// router.create() 第二参是 unknown（原始请求体）；测试里用这个局部类型标注请求形状。
type ChatCompletionRequest = { model: string; messages: Array<{ role: string; content: unknown; [k: string]: unknown }>; [k: string]: unknown };

// 2026-09-09（feat/vision-multimodal）：router 集成测试——
//  vision model + array content 含 image_url → uploadFile → pollFileReady → completion with ref_file_ids
//  flash/pro + array content 含 image_url → 400（保留 v0.1.66 拒绝行为）
//  text-only（string content）→ 现状不变

function makeMockAdapter(opts: {
  uploadFile?: ProviderAdapter['uploadFile'];
  pollFileReady?: ProviderAdapter['pollFileReady'];
} = {}): ProviderAdapter & { streamCalls: ProviderCompletion[] } {
  const streamCalls: ProviderCompletion[] = [];
  return {
    id: 'deepseek',
    auth: { loginPageUrl: '', cookieDomain: '', requiredCookies: [], getAuthStatus: async () => ({ state: 'logged_in' as const }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: 's1', parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    uploadFile: opts.uploadFile,
    pollFileReady: opts.pollFileReady,
    async *streamCompletion(_ctx, req): AsyncIterable<ProviderStreamEvent> {
      streamCalls.push(req);
      yield { kind: 'content_delta', content: '看到了，这是电路图' };
      yield { kind: 'usage', inputTokens: 100, outputTokens: 50 };
    },
    models: [
      { id: 'deepseek-v4-flash', provider: 'deepseek', description: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', provider: 'deepseek', description: 'deepseek-v4-pro' },
      { id: 'deepseek-v4-flash-vision-exp', provider: 'deepseek', description: 'deepseek-v4-flash-vision-exp' },
    ],
    resolveModel(): ResolvedModel | null {
      return { modelId: 'deepseek-v4-flash-vision-exp', modelType: 'vision', thinking: true, limitChars: 100000 };
    },
    isRateLimited: () => false,
    isAuthExpired: () => false,
    isUnavailable: () => false,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    streamCalls,
  } as ProviderAdapter & { streamCalls: ProviderCompletion[] };
}

// 2026-09-10（merge）：combined signature supporting HEAD's logSink (v0.1.85 vision-error tests) +
// feat/models-sync's storageStub (Task 5 catalog-merge tests).
function makeRouter(
  adapter: ProviderAdapter,
  opts: { logSink?: any[]; storageStub?: { get: (k: string) => Promise<unknown | undefined> } } = {},
): Router {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 2, ttlMs: 60_000 },
  );
  const queue = new Queue({ timeoutMs: 60_000, now });
  const ring = new RingLog(20);
  const log: RingLog = opts.logSink
    ? new Proxy(ring, { get(t, p) { if (p === 'push') { return (e: unknown) => { ring.push(e as never); opts.logSink!.push(e); }; } return Reflect.get(t, p); } }) as unknown as RingLog
    : ring;
  return new Router({
    registry: { deepseek: adapter }, mapper, queue, now, log,
    storage: { get: opts.storageStub?.get ?? (async () => undefined), set: async () => undefined },
    version: '0.0.0-test',
  });
}

describe('router: vision multimodal 路由', () => {
  const ctx: ProviderContext = { token: 'T', requestId: 'r1' };

  it('vision + array content 含 image_url：uploadFile → pollFileReady → completion 带 ref_file_ids + prompt 渲染 [image]', async () => {
    const uploadFile = vi.fn(async (_c, _bytes, _mime, _name) => ({
      id: 'file-deadbeef-1234', filename: 'x.png', bytes: 11, status: 'uploaded',
    }));
    const pollFileReady = vi.fn(async () => {});
    const adapter = makeMockAdapter({ uploadFile, pollFileReady });
    const router = makeRouter(adapter);
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这电路图有什么问题' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      }],
    };
    const res: any = await router.create('T', req);
    expect(res.choices[0].message.content).toBe('看到了，这是电路图');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(pollFileReady).toHaveBeenCalledWith(expect.anything(), 'file-deadbeef-1234', expect.anything());
    expect(adapter.streamCalls).toHaveLength(1);
    const sent = adapter.streamCalls[0]!;
    expect(sent.refFileIds).toEqual(['file-deadbeef-1234']);
    expect(sent.prompt).toContain('这电路图有什么问题');
    expect(sent.prompt).toContain('[image]');
    expect(sent.model.modelType).toBe('vision');
  });

  it('vision + array content 仅 text 块（无 image_url）：不调 uploadFile，直接转发', async () => {
    const uploadFile = vi.fn();
    const pollFileReady = vi.fn();
    const adapter = makeMockAdapter({ uploadFile, pollFileReady });
    const router = makeRouter(adapter);
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }],
    };
    await router.create('T', req);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(pollFileReady).not.toHaveBeenCalled();
    expect(adapter.streamCalls).toHaveLength(1);
    expect(adapter.streamCalls[0]!.prompt).toBe('纯文本');
  });

  it('vision + string content：现状不变（不调 upload）', async () => {
    const uploadFile = vi.fn();
    const adapter = makeMockAdapter({ uploadFile });
    const router = makeRouter(adapter);
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: '纯文本' }],
    };
    await router.create('T', req);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('flash + array content 含 image_url：拒绝（保留 v0.1.66 行为）', async () => {
    const adapter = makeMockAdapter({});
    adapter.resolveModel = (() => ({ modelId: 'deepseek-v4-flash', modelType: 'default', thinking: false, limitChars: 100000 }));
    const router = makeRouter(adapter);
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ] }],
    };
    await expect(router.create('T', req)).rejects.toMatchObject({
      error: {
        error: {
          code: 'invalid_request_error',
          message: expect.stringContaining('image_url'),
        },
      },
    });
  });

  it('vision + 多张图：多个 file_id 传给 ref_file_ids', async () => {
    const uploadFile = vi.fn(async (_c, _b, _m, name) => ({
      id: `file-${name}`, filename: name, bytes: 1, status: 'uploaded',
    }));
    const adapter = makeMockAdapter({ uploadFile, pollFileReady: async () => {} });
    const router = makeRouter(adapter);
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,bbb' } },
      ] }],
    };
    await router.create('T', req);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(adapter.streamCalls[0]!.refFileIds).toEqual(['file-img0.png', 'file-img1.png']);
    expect(adapter.streamCalls[0]!.prompt).toBe('[image][image]');
  });

  // 2026-09-10（fix/sw-vision-error）：v0.1.82 现场——vision + 图片发送后
  // 静默失败。根因：router.create 入口的 vision pipeline（upload / poll / atob）
  // 拋错后未被任何 try/catch 包住。SW 端没有 unhandledrejection 监听 → console 静默。
  // 修复：router 在 vision pipeline 拋错时包 try/catch + 写 log + 重拋明确 BridgeError，
  // 让 SW 也能接住「vision pipeline 失败」详情。不变接口：调用方仍接收 reject。
  it('vision + 图片：uploadFile reject → router 写 log + 拋带 message 的 BridgeError', async () => {
    const uploadFile = vi.fn(async () => {
      throw Object.assign(new Error('upload failed: 401 unauthorized'), { status: 401 });
    });
    const adapter = makeMockAdapter({ uploadFile, pollFileReady: async () => {} });
    const log: any[] = [];
    const router = makeRouter(adapter, { logSink: log });
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看这图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE' } },
      ] }],
    };
    await expect(router.create('T', req)).rejects.toMatchObject({
      error: {
        error: {
          code: 'provider_unavailable',
          message: expect.stringMatching(/upload failed|401/),
        },
      },
    });
    // 错误应被记入 log（不是静默）
    const errEntry = log.find((e) => e.ok === false && e.model === 'deepseek-v4-flash-vision-exp');
    expect(errEntry).toBeTruthy();
    expect(errEntry.error).toMatch(/upload|401/);
  });

  it('vision + 图片：pollFileReady 超时 → router 写 log + 拋带 message 的 BridgeError', async () => {
    const uploadFile = vi.fn(async () => ({ id: 'file-abc', filename: 'x.png', bytes: 11, status: 'uploaded' }));
    const pollFileReady = vi.fn(async () => {
      throw new Error('pollFileReady timeout after 10 attempts (fileId=file-abc)');
    });
    const adapter = makeMockAdapter({ uploadFile, pollFileReady });
    const log: any[] = [];
    const router = makeRouter(adapter, { logSink: log });
    const req: ChatCompletionRequest = {
      model: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ] }],
    };
    await expect(router.create('T', req)).rejects.toMatchObject({
      error: { error: { message: expect.stringMatching(/pollFileReady|timeout/) } },
    });
    expect(log.find((e) => e.ok === false && e.model === 'deepseek-v4-flash-vision-exp')).toBeTruthy();
  });

  it('vision + 图片：image_url download HTTP 404 → 拋 invalid_request_error（400）+ log 记录', async () => {
    // fetch mock 返回 404（HTTP URL 场景）
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 404 } as Response));
    try {
      const adapter = makeMockAdapter({ uploadFile: vi.fn(), pollFileReady: vi.fn() });
      const log: any[] = [];
      const router = makeRouter(adapter, { logSink: log });
      const req: ChatCompletionRequest = {
        model: 'deepseek-v4-flash-vision-exp',
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: 'https://example.com/notfound.png' } },
        ] }],
      };
      await expect(router.create('T', req)).rejects.toMatchObject({
        error: { error: { code: 'invalid_request_error', message: expect.stringMatching(/404/) } },
      });
      expect(log.find((e) => e.ok === false)).toBeTruthy();
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });


// 2026-09-10（feat/models-sync）：router.models() 合并 catalog（Task 5）。
// 验证：当 storage 有 modelsCatalog 且在 7 天 TTL 内，description 被替换为捕获的 label；
//  storage 缺失 / 超时 → fall back 到 hardcoded description（= id）。
describe('router.models(): merged catalog from storage', () => {
  it('falls back to hardcoded descriptions when no catalog in storage', async () => {
    const adapter = makeMockAdapter({});
    const router = makeRouter(adapter, { storageStub: { get: async () => undefined } });
    const r = await router.models();
    expect(r.data.map((m) => m.description)).toEqual([
      'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp',
    ]);
  });

  it('enriches description with captured label when catalog is fresh (within 7d TTL)', async () => {
    const capturedAt = Date.now();
    const adapter = makeMockAdapter({});
    const router = makeRouter(adapter, {
      storageStub: {
        get: async (k: string) => k === 'modelsCatalog' ? {
          source: 'chat.deepseek.com', capturedAt,
          models: [
            { label: 'DeepSeek V4 Flash' },
            { label: 'DeepSeek V4 Pro' },
            { label: 'DeepSeek V4 Flash Vision Exp' },
          ],
        } : undefined,
      },
    });
    const r = await router.models();
    expect(r.data.map((m) => m.description)).toEqual([
      'DeepSeek V4 Flash', 'DeepSeek V4 Pro', 'DeepSeek V4 Flash Vision Exp',
    ]);
  });
});
});
