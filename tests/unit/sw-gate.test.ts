// 2026-10-01（fix/auth-end-to-end）：token 门禁下沉到 provider 维度。ChatGPT 已在 registry 里，
// 但既有 `if (!token) 503 '未登录 chat.deepseek.com'` 把只登录 ChatGPT 的用户一起拦死。
// 本文件覆盖 sw-gate.ts 的纯函数 needsDeepSeekToken：判定矩阵见文档注释 + 实施指令。
import { describe, it, expect } from 'vitest';
import { needsDeepSeekToken } from '../../src/background/sw-gate';
import type { ProviderAdapter, ResolvedModel } from '../../src/background/providers/adapter';

/** 最小 ProviderAdapter stub：只用到 resolveModel + id 两个字段。 */
function mkAdapter(id: string, accepts: string[]): ProviderAdapter {
  const set = new Set(accepts);
  return {
    id,
    auth: { loginPageUrl: '', getAuthStatus: async () => ({ state: 'logged_out' }) },
    createSession: async () => ({ providerId: id, webSessionId: '', parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: (async function* () { void 0; }) as unknown as ProviderAdapter['streamCompletion'],
    models: [],
    resolveModel: (m: string): ResolvedModel | null => set.has(m)
      ? { modelId: m, variant: 'default', supportsImages: false, thinking: false, limitChars: 1000 }
      : null,
    isRateLimited: () => false,
    isAuthExpired: () => false,
    isUnavailable: () => false,
  };
}

const registry = {
  deepseek: mkAdapter('deepseek', ['deepseek-v4-flash', 'deepseek-v4-pro']),
  chatgpt: mkAdapter('chatgpt', ['gpt-5-5', 'gpt-5-6', 'auto']),
};

describe('needsDeepSeekToken（token 门禁下沉到 provider 维度）', () => {
  // ----- chatgpt 模型 → 不要求 token -----
  it('chat.completions.create + gpt-5-5 → false（chatgpt 已注册，token 门禁不下沉到 chatgpt）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'gpt-5-5' } }, registry)).toBe(false);
  });

  it('chat.completions.create + gpt-5-6 → false', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'gpt-5-6' } }, registry)).toBe(false);
  });

  it('chat.completions.create + auto → false（auto 解析到 chatgpt）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'auto' } }, registry)).toBe(false);
  });

  // ----- DeepSeek 模型 → 仍要求 token（保留既有判定）-----
  it('chat.completions.create + deepseek-v4-flash → true（深先既有判定保持不变）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'deepseek-v4-flash' } }, registry)).toBe(true);
  });

  it('chat.completions.create + deepseek-v4-pro → true', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'deepseek-v4-pro' } }, registry)).toBe(true);
  });

  // ----- 未知 model → false（不解析到 DeepSeek，gate 不要求 token；router 后续抛 400）-----
  it('chat.completions.create + 未知模型 → false（不解析到 DeepSeek → 不要求 token；router 抛 400）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 'gpt-unknown' } }, registry)).toBe(false);
  });

  // ----- 其它方法：不要求 token -----
  it('models.list → false（不需要 token 也能列出所有 provider 的模型）', () => {
    expect(needsDeepSeekToken({ method: 'models.list' }, registry)).toBe(false);
  });

  it('chat.completions.cancel → false（取消请求不需要 token）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.cancel', params: { requestId: 1 } }, registry)).toBe(false);
  });

  it('auth.requested → false（仅返回当前缓存态）', () => {
    expect(needsDeepSeekToken({ method: 'auth.requested' }, registry)).toBe(false);
  });

  it('auth.sync → false（content script 推送 token，本身就不该被 token gate 拒）', () => {
    expect(needsDeepSeekToken({ method: 'auth.sync', params: { token: 'x' } }, registry)).toBe(false);
  });

  // ----- chat.completions.create 缺 model / 畸形：按原行为（要求 token）-----
  it('chat.completions.create + 缺 model → true（router 抛 400，但 token 检查保持原顺序）', () => {
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: {} }, registry)).toBe(true);
    expect(needsDeepSeekToken({ method: 'chat.completions.create' }, registry)).toBe(true);
    expect(needsDeepSeekToken({ method: 'chat.completions.create', params: { model: 123 } }, registry)).toBe(true);
  });
});