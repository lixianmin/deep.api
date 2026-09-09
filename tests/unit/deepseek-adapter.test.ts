import { describe, it, expect, vi } from 'vitest';
import { createDeepSeekAdapter, type AdapterDeps } from '../../src/background/providers/deepseek/adapter';
import { PowSolver } from '../../src/background/providers/deepseek/pow';
import type { AuthStatus, ProviderCompletion, ProviderContext } from '../../src/background/providers/adapter';

function mkDeps(over: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    getToken: vi.fn(async () => 'tok'),
    fetchJson: vi.fn(async () => { throw new Error('unexpected fetchJson'); }),
    fetchStream: vi.fn(async () => { throw new Error('unexpected fetchStream'); }),
    pow: new PowSolver({ fetchJson: async () => { throw new Error('unexpected'); }, fetchBytes: async () => new Uint8Array(), instantiate: async () => { throw new Error('no'); }, wasmUrl: 'u' }),
    now: () => 0,
    ...over,
  };
}

describe('DeepSeekAdapter', () => {
  it('resolves current public models and rejects unknown', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(a.resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'default', thinking: true });
    // 2026-09-09（fix/pro-thinking-default）：Pro 默认 thinking=false 走直答路径，避免 web API
    // 上「只思考不说话」B-3 场景（0 content 返 ready+遥测）。Flash / vision 保持 true。
    expect(a.resolveModel('deepseek-v4-pro')).toMatchObject({ modelType: 'expert', thinking: false });
    expect(a.resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', thinking: true });
    expect(a.resolveModel('gpt-4o')).toBeNull();
    const ids = a.models.map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']));
  });

  it('exposes capability flags', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(a.capabilities).toEqual({ thinking: true, functionCalling: 'prompt-engineered' });
    expect(a.id).toBe('deepseek');
    expect(a.auth.loginPageUrl).toBe('https://chat.deepseek.com/');
    expect(a.auth.cookieDomain).toBe('chat.deepseek.com');
    expect(a.auth.requiredCookies).toEqual(expect.arrayContaining(['userToken']));
  });

  // 2026-09-09（fix/expert-client-version）：v0.1.75 sseRaw 现场抓到服务端明确错误：
  // {"type":"error","content":"Update to the latest version to use Expert.","finish_reason":"unsupported_client_by_model"}
  // Pro（model_type=expert）在 chat.deepseek.com/api/v0 上强制检查客户端版本——网页端/官方客户端
  // 都带 x-app-version / x-client-version 等浏览器指纹头，deep.api 只带 Authorization+Content-Type
  // 被视为「旧客户端」→ 服务端拒绝 Expert（Flash default 不检查所以正常）。
  // 对齐 nguyenduclong-ict/llmweb2api（可工作的参考实现）的 webHeaders。
  // 修：streamCompletion 请求头加 x-app-version / x-client-version / x-client-platform / x-client-locale。
  it('fix-to-pass: streamCompletion headers 带客户端版本指纹（expert 必备）', async () => {
    let sentHeaders: Record<string, string> | undefined;
    const a = createDeepSeekAdapter(mkDeps({
      fetchStream: vi.fn(async (path: string, headers: Record<string, string>) => {
        sentHeaders = headers;
        return { status: 200, headers: new Headers(), body: (async function* () { yield new TextEncoder().encode('event: ready\ndata: {}\n\n'); })() as unknown as AsyncIterable<Uint8Array> };
      }),
      pow: { getChallenge: async () => ({}), solve: async () => 'pow-ok' } as any,
    }));
    const ctx: ProviderContext = { token: 'tok' } as any;
    const req: ProviderCompletion = {
      session: { webSessionId: 's1', parentMessageId: null } as any,
      prompt: 'hi',
      model: { modelId: 'deepseek-v4-pro', modelType: 'expert', thinking: false } as any,
    } as any;
    for await (const _ of a.streamCompletion(ctx, req)) { void _; }
    expect(sentHeaders?.['x-client-version']).toBe('2.4.0');
    expect(sentHeaders?.['x-client-bundle-id']).toBe('com.deepseek.chat');
    expect(sentHeaders?.['x-client-locale']).toBe('en_US');
  });

  it('classifies errors: 429 → rate-limited', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(a.isRateLimited({ status: 429 })).toBe(true);
    expect(a.isRateLimited({ status: 200 })).toBe(false);
  });

  it('classifies errors: 401 → auth-expired', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(a.isAuthExpired({ status: 401 })).toBe(true);
    expect(a.isAuthExpired({ status: 200 })).toBe(false);
  });

  it('classifies errors: WAF / 5xx / network → unavailable', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(a.isUnavailable({ status: 202, headers: { 'x-amzn-waf-action': 'challenge' } })).toBe(true);
    expect(a.isUnavailable(new TypeError('fetch failed'))).toBe(true);
    expect(a.isUnavailable({ status: 500 })).toBe(true);
    expect(a.isUnavailable({ status: 429 })).toBe(false);
    expect(a.isUnavailable({ status: 200 })).toBe(false);
  });

  it('getAuthStatus returns logged_out when no token', async () => {
    const deps = mkDeps({ getToken: async () => null });
    const a = createDeepSeekAdapter(deps);
    const status: AuthStatus = await a.auth.getAuthStatus({ token: '', requestId: 'r' });
    expect(status.state).toBe('logged_out');
  });

  it('getAuthStatus returns logged_in when token + probe succeeds', async () => {
    const deps = mkDeps({
      fetchJson: vi.fn(async (path: string) => {
        if (path === '/chat_session/create') return { data: { chat_session: { id: 'sess-x' } } };
        if (path === '/chat_session/delete') return { data: null };
        throw new Error('unexpected ' + path);
      }),
    });
    const a = createDeepSeekAdapter(deps);
    const status = await a.auth.getAuthStatus({ token: 'tok', requestId: 'r' });
    expect(status.state).toBe('logged_in');
    expect(deps.fetchJson).toHaveBeenCalledWith('/chat_session/create', expect.objectContaining({ Authorization: 'Bearer tok' }), {});
  });

  it('getAuthStatus returns expired on 401 with clear message', async () => {
    const deps = mkDeps({
      fetchJson: vi.fn(async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); }),
    });
    const a = createDeepSeekAdapter(deps);
    const status = await a.auth.getAuthStatus({ token: 'tok', requestId: 'r' });
    expect(status.state).toBe('expired');
    expect((status as { state: 'expired'; message?: string }).message).toMatch(/401/);
  });
});
