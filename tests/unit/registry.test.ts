import { describe, it, expect } from 'vitest';
import { createRegistry } from '../../src/background/providers/registry';
import type { ProviderAdapter } from '../../src/background/providers/adapter';

// 2026-10-01（stage-a2/debt-task2）：变参 createRegistry 测试。
// 用 as unknown as ProviderAdapter 绕过可选字段，仅填测试所需的最小字段集。

const makeAdapter = (id: string): ProviderAdapter =>
  ({
    id,
    auth: {
      loginPageUrl: 'http://localhost',
      getAuthStatus: async () => ({ state: 'logged_in' }),
    },
    createSession: async () => ({ id: 's1', conversationId: 'c1' }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* () {},
    models: [],
    resolveModel: () => null,
    isRateLimited: () => false,
    isAuthExpired: () => false,
    isUnavailable: () => false,
  } as unknown as ProviderAdapter);

describe('createRegistry', () => {
  it('单 adapter 正常注册', () => {
    const a = makeAdapter('deepseek');
    const reg = createRegistry(a);
    expect(Object.keys(reg)).toEqual(['deepseek']);
  });

  it('两个不同 id 的 adapter 都能被解析', () => {
    const a = makeAdapter('deepseek');
    const b = makeAdapter('other');
    const reg = createRegistry(a, b);
    expect(Object.keys(reg)).toContain('deepseek');
    expect(Object.keys(reg)).toContain('other');
    expect(Object.keys(reg).length).toBe(2);
  });

  it('重复 id 时后者覆盖前者（Object.fromEntries 语义）', () => {
    const a = makeAdapter('deepseek');
    const b = { ...a, id: 'deepseek' as const };
    const reg = createRegistry(a, b);
    expect(Object.keys(reg).length).toBe(1);
    expect(reg['deepseek']).toStrictEqual(b);
  });

  it('空调用返回空对象', () => {
    const reg = createRegistry();
    expect(Object.keys(reg).length).toBe(0);
  });
});
