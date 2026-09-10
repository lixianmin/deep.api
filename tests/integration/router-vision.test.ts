import { describe, it, expect, vi } from 'vitest';
import { Router } from '../../src/background/router';
import { SessionMapper } from '../../src/background/session-mapper';
import { Queue } from '../../src/background/queue';
import { RingLog } from '../../src/background/log';
import type { ChatCompletionRequest, ProviderAdapter, ProviderCompletion, ProviderContext, ResolvedModel, ProviderStreamEvent, ProviderSession } from '../../src/background/providers/adapter';

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
    models: [],
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

function makeRouter(adapter: ProviderAdapter): Router {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper(
    { createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now },
    { poolSize: 2, ttlMs: 60_000 },
  );
  const queue = new Queue({ timeoutMs: 60_000, now });
  return new Router({ registry: { deepseek: adapter }, mapper, queue, now, log: new RingLog(20) });
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
});