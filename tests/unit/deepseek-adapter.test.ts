import { describe, it, expect, vi } from 'vitest';
import { createDeepSeekAdapter, type AdapterDeps } from '../../src/background/providers/deepseek/adapter';
import { PowSolver } from '../../src/background/providers/deepseek/pow';
import type { AuthStatus, ProviderCompletion, ProviderContext, ProviderStreamEvent } from '../../src/background/providers/adapter';
import { continuePayload, continueHeaders } from '../../src/background/providers/deepseek/client';

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
  it('resolves current public models (V4.1 unified) and rejects unknown', () => {
    const a = createDeepSeekAdapter(mkDeps());
    // 2026-09-14（fix/models-v4-retired）：V4 三个 chat ID retired，只 1 个新 chat ID。
    // 2026-09-10（fix/vision-model-type）：deepseek-flash 改为 wire model_type='default' +
    // 独立 supportsImages（避开 vision 变体的 DSML 工具调用格式）。
    expect(a.resolveModel('deepseek-flash')).toMatchObject({ modelType: 'default', supportsImages: true, thinking: true });
    // vision 兼容层仍保留
    expect(a.resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', supportsImages: true, thinking: true });
    // 2026-09-14（fix/accept-v4-flash-alias）：`deepseek-v4-flash` 恢复兼容解析（旧下游仍发此 ID）
    expect(a.resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'default', supportsImages: true, thinking: true });
    // 仍未恢复的旧 V4 chat ID
    expect(a.resolveModel('deepseek-v4-pro')).toBeNull();
    expect(a.resolveModel('gpt-4o')).toBeNull();
    // a.models 只暴露 1 个 chat model
    const ids = a.models.map((m) => m.id);
    expect(ids).toEqual(['deepseek-flash']);
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

// 2026-09-12（feat/continue-on-incomplete）：续接端点（spec §3.2/§2 F2）。
describe('continueStream（feat/continue-on-incomplete）', () => {
  it('continuePayload/continueHeaders：实测形状、无 PoW', () => {
    const p = continuePayload({ providerId: 'deepseek', webSessionId: 's1', parentMessageId: 3 } as any, 4);
    expect(p).toEqual({ chat_session_id: 's1', message_id: 4, fallback_to_resume: true });
    const h = continueHeaders('tok');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['x-client-version']).toBe('2.4.0');
    expect(h['X-Ds-Pow-Response']).toBeUndefined();   // continue 不要求 PoW
  });

  it('fail-to-pass: continueStream 请求 /chat/continue、不调 PoW、SSE 事件接线', async () => {
    let path = '';
    let sent: Record<string, string> = {};
    const sse = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"hi"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const a = createDeepSeekAdapter(mkDeps({
      fetchStream: vi.fn(async (p: string, h: Record<string, string>) => {
        path = p; sent = h;
        return {
          status: 200, headers: new Headers(),
          body: (async function* () { yield new TextEncoder().encode(sse); })() as unknown as AsyncIterable<Uint8Array>,
        };
      }),
      // pow 被调用即抛 —— continue 路径不得触碰 PoW
      pow: { getChallenge: vi.fn(async () => { throw new Error('continue must not call pow'); }), solve: vi.fn() } as any,
    }));
    const evs: ProviderStreamEvent[] = [];
    for await (const ev of a.continueStream!(
      { token: 'tok', requestId: 'r' },
      { providerId: 'deepseek', webSessionId: 's1', parentMessageId: 3 } as any,
      4,
      { thinkingChars: 0, responseChars: 0 },
    )) evs.push(ev);
    expect(path).toBe('/chat/continue');               // 无双前缀
    expect(sent['X-Ds-Pow-Response']).toBeUndefined();
    expect(evs.some((e) => e.kind === 'message_id' && e.id === 4)).toBe(true);
    expect(evs.some((e) => e.kind === 'content_delta' && e.content === 'hi')).toBe(true);
  });
});
