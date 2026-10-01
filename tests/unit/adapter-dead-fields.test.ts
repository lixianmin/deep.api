// 2026-10-01（stage-a/decouple-provider）：阶段 A 第 2 步——验证 shared interface 里三个死字段
// 已被删除：capabilities、auth.cookieDomain、auth.requiredCookies。
// 这三个字段在接口与实现里都存在，但在整个代码库里没有任何读取点（grep 核实）。
// 本测试确保它们不会"复活"——一旦有人重新加上，测试立刻失败。
import { describe, it, expect, vi } from 'vitest';
import { createDeepSeekAdapter } from '../../src/background/providers/deepseek/adapter';
import { PowSolver } from '../../src/background/providers/deepseek/pow';
import type { AdapterDeps } from '../../src/background/providers/deepseek/adapter';

function mkDeps(): AdapterDeps {
  return {
    getToken: vi.fn(async () => 'tok'),
    fetchJson: vi.fn(async () => { throw new Error('not used'); }),
    fetchStream: vi.fn(async () => { throw new Error('not used'); }),
    pow: new PowSolver({ fetchJson: async () => { throw new Error('not used'); }, fetchBytes: async () => new Uint8Array(), instantiate: async () => { throw new Error('not used'); }, wasmUrl: 'u' }),
    now: () => 0,
  };
}

describe('阶段 A · shared interface 死字段已清理', () => {
  it('adapter 对象上不存在 capabilities 键', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(Object.keys(a)).not.toContain('capabilities');
  });

  it('adapter.auth 上不存在 cookieDomain 键', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(Object.keys(a.auth)).not.toContain('cookieDomain');
  });

  it('adapter.auth 上不存在 requiredCookies 键', () => {
    const a = createDeepSeekAdapter(mkDeps());
    expect(Object.keys(a.auth)).not.toContain('requiredCookies');
  });
});
