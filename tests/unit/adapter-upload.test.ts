import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDeepSeekAdapter, type AdapterDeps } from '../../src/background/providers/deepseek/adapter';
import type { ProviderContext } from '../../src/background/providers/adapter';

// 2026-09-09（feat/vision-multimodal）：spike #2 用户真实 curl 现场——
// /api/v0/file/upload_file 接受 multipart/form-data，必带 headers：
//   x-ds-pow-response（pow target_path=/api/v0/file/upload_file）
//   x-file-size, x-model-type:vision, x-thinking-enabled:1
//   x-client-* 指纹（沿用现有 withPowHeaders 集合）
// 响应：{code:0, data:{biz_code:0, biz_data:{id:"file-<UUID>", filename, bytes, status}}}
// file_id 格式：`file-<UUID>`（spike 现场 file-5232d461-f059-...）
// pollFileReady 端点 /api/v0/file/fetch_files?file_ids=... 轮询直到 status ∈ ready/done/.../uploaded

interface MockResp { status?: number; jsonBody?: unknown; contentType?: string }
function makeDeps(respond: (path: string, init: { method?: string; body?: unknown }) => MockResp): AdapterDeps {
  const fetchJson = vi.fn(async (path: string, headers: Record<string, string>, body: unknown) => {
    const init = { method: 'POST', body };
    const r = respond(path, init);
    if (r.status && r.status >= 400) throw Object.assign(new Error(`http ${r.status}`), { status: r.status });
    return r.jsonBody;
  });
  const fetchRaw = vi.fn(async (path: string, headers: Record<string, string>, init: { method?: string; body?: unknown }) => {
    const r = respond(path, init);
    return {
      status: r.status || 200,
      json: async () => r.jsonBody,
      text: async () => JSON.stringify(r.jsonBody),
    };
  });
  const fetchStream = vi.fn(async () => {
    throw new Error('not used in upload tests');
  });
  const pow = {
    getChallenge: vi.fn(async (ctx: ProviderContext, targetPath: string) => ({
      algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', target_path: targetPath,
    })),
    solve: vi.fn(async () => 'POW_HEADER_VALUE'),
  };
  return { getToken: async () => 'TEST_TOKEN', fetchJson, fetchRaw, fetchStream, pow, now: () => 1000 };
}
const ctx: ProviderContext = { token: 'TEST_TOKEN', requestId: 'r-test' };

describe('deepseek adapter: uploadFile + pollFileReady', () => {
  let uploads: Array<{ path: string; init: { method?: string; body?: unknown } }> = [];
  let polls: Array<{ path: string; init: { method?: string; body?: unknown } }> = [];

  beforeEach(() => { uploads = []; polls = []; });

  it('uploadFile: posts to /file/upload_file with required headers and multipart body', async () => {
    const deps = makeDeps((path, init) => {
      if (path === '/file/upload_file') {
        uploads.push({ path, init });
        return { jsonBody: { code: 0, data: { biz_code: 0, biz_data: { id: 'file-abc-123', filename: 'x.png', bytes: 11, status: 'uploaded' } } } };
      }
      throw new Error('unexpected path: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    const result = await a.uploadFile!(ctx, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 'image/png', 'x.png');
    expect(result.id).toBe('file-abc-123');
    expect(uploads).toHaveLength(1);
    const req = uploads[0]!;
    expect(req.path).toBe('/file/upload_file');
    const body = req.init.body as Uint8Array;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    expect(text).toMatch(/Content-Disposition: form-data; name="file"; filename="x\.png"/);
    expect(text).toMatch(/Content-Type: image\/png/);
  });

  it('uploadFile: pow target_path 是 /api/v0/file/upload_file（不是 /chat/completion）', async () => {
    const deps = makeDeps((path) => {
      if (path === '/file/upload_file') return { jsonBody: { code: 0, data: { biz_code: 0, biz_data: { id: 'file-x' } } } };
      throw new Error('unexpected path: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    await a.uploadFile!(ctx, new Uint8Array([0xff]), 'image/png', 'y.png');
    const chal = (deps.pow.getChallenge as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chal[1]).toBe('/api/v0/file/upload_file');
    // 同时验证请求里确实带 pow response（来自 solve）
    const raw = (deps.fetchRaw as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = raw[1] as Record<string, string>;
    expect(headers['X-Ds-Pow-Response']).toBe('POW_HEADER_VALUE');
    expect(headers['x-file-size']).toBe('1');
    expect(headers['x-model-type']).toBe('vision');
    expect(headers['x-thinking-enabled']).toBe('1');
    expect(headers['x-client-version']).toBe('2.4.0');
    expect(headers['x-client-bundle-id']).toBe('com.deepseek.chat');
  });

  it('uploadFile: biz_code 非 0 → 抛错', async () => {
    const deps = makeDeps(() => ({
      jsonBody: { code: 0, data: { biz_code: 4001, biz_msg: 'invalid file' } },
    }));
    const a = createDeepSeekAdapter(deps);
    await expect(a.uploadFile!(ctx, new Uint8Array([1]), 'image/png', 'z.png'))
      .rejects.toThrow(/invalid file|Upload failed/);
  });

  it('uploadFile: 响应缺 id → 抛错', async () => {
    const deps = makeDeps(() => ({ jsonBody: { code: 0, data: { biz_code: 0 } } }));
    const a = createDeepSeekAdapter(deps);
    await expect(a.uploadFile!(ctx, new Uint8Array([1]), 'image/png', 'z.png'))
      .rejects.toThrow(/no file id/i);
  });

  it('pollFileReady: 命中 ready 立即返回', async () => {
    const deps = makeDeps((path, init) => {
      if (path.startsWith('/file/fetch_files')) {
        polls.push({ path, init });
        return { jsonBody: { data: { biz_data: { files: [{ status: 'uploaded' }] } } } };
      }
      throw new Error('unexpected: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    await expect(a.pollFileReady!(ctx, 'file-abc-123', { maxAttempts: 3, intervalMs: 1 })).resolves.toEqual({ ready: true });
    expect(polls).toHaveLength(1);
    expect(polls[0]!.path).toContain('file_ids=file-abc-123');
    // 2026-09-11（fix/review-r1）：fetchRaw 契约是相对路径（sw.ts 拼 DEEPSEEK_API_BASE），
    // 带 /api/v0 前缀会拼成双重前缀（memory 架构决策 #4）。
    expect(polls[0]!.path.startsWith('/api/v0')).toBe(false);
    expect(polls[0]!.init.method).toBe('GET');
  });

  // 2026-09-10（fix/vision-errors）：现场——用户带图发送后服务器无任何响应，Debug 图片过一段时间消失。
  // 根因：pollFileReady 超时直接抛错 → completion 根本没发生 → SW 发 error 帧 → chat.ts 不识别 error 帧 → 空回复。
  // 修：超时不再抛错（参考 llmweb2api：只记录，继续发 completion 带 ref_file_ids，服务端可能已处理完）。
  it('pollFileReady: 持续 WIP → 超时返回 {ready:false}（非致命，调用方继续发 completion 并记 warning）', async () => {
    const deps = makeDeps((path) => {
      if (path.startsWith('/file/fetch_files')) {
        return { jsonBody: { data: { biz_data: { files: [{ status: 'processing' }] } } } };
      }
      throw new Error('unexpected: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    await expect(a.pollFileReady!(ctx, 'file-abc-123', { maxAttempts: 3, intervalMs: 1 })).resolves.toEqual({ ready: false });
  });

  it('pollFileReady: fetch_files 单次抛错也不致命 → 继续轮询，超时后 resolve', async () => {
    let calls = 0;
    const deps = makeDeps((path) => {
      if (path.startsWith('/file/fetch_files')) {
        calls++;
        if (calls === 1) throw new Error('network flake');
        return { jsonBody: { data: { biz_data: { files: [{ status: 'processing' }] } } } };
      }
      throw new Error('unexpected: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    await expect(a.pollFileReady!(ctx, 'file-abc-123', { maxAttempts: 2, intervalMs: 1 })).resolves.toEqual({ ready: false });
  });

  it('pollFileReady: 服务端报 FAILED → 抛错', async () => {
    const deps = makeDeps((path) => {
      if (path.startsWith('/file/fetch_files')) {
        return { jsonBody: { data: { biz_data: { files: [{ status: 'FAILED' }] } } } };
      }
      throw new Error('unexpected: ' + path);
    });
    const a = createDeepSeekAdapter(deps);
    await expect(a.pollFileReady!(ctx, 'file-x', { maxAttempts: 3, intervalMs: 1 }))
      .rejects.toThrow(/parse failed/i);
  });
});