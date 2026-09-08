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
    expect(a.resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'default', thinking: false });
    expect(a.resolveModel('deepseek-v4-pro')).toMatchObject({ modelType: 'expert', thinking: true });
    expect(a.resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', thinking: false });
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
    expect(a.auth.requiredCookies).toEqual(expect.arrayContaining(['user_token']));
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
        if (path === '/api/v0/chat_session/create') return { data: { chat_session: { id: 'sess-x' } } };
        if (path === '/api/v0/chat_session/delete') return { data: null };
        throw new Error('unexpected ' + path);
      }),
    });
    const a = createDeepSeekAdapter(deps);
    const status = await a.auth.getAuthStatus({ token: 'tok', requestId: 'r' });
    expect(status.state).toBe('logged_in');
    expect(deps.fetchJson).toHaveBeenCalledWith('/api/v0/chat_session/create', expect.objectContaining({ Authorization: 'Bearer tok' }), {});
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
