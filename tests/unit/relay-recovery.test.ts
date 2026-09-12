// 2026-09-16（feat/relay-auto-recovery）：扩展重载/更新后，SW（onInstalled）向所有开着的
// http/https 标签页重注入 bridge-relay.js，孤儿 relay 被新 relay 接管，桥免刷新自动恢复。
// 本文件覆盖 SW 侧恢复层：逐 tab 注入、单 tab 失败不阻塞其余、注入范围与 manifest 一致（仅顶层 frame）。
import { describe, it, expect, vi } from 'vitest';
import { createRelayRecovery } from '../../src/background/relay-recovery';

describe('relay-recovery（扩展重载后的桥自动恢复）', () => {
  it('对所有查到的标签页逐个注入 bridge-relay.js（顶层 frame，与 manifest 一致）', async () => {
    const calls: Array<{ tabId: number; files: string[]; allFrames?: boolean }> = [];
    const recover = createRelayRecovery({
      queryTabs: async () => [{ id: 1 }, { id: 2 }, {}],   // 无 id 的 tab 应跳过
      executeScript: async (inj) => { calls.push({ tabId: inj.target.tabId, files: inj.files, allFrames: inj.allFrames }); },
    });
    await recover();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ tabId: 1, files: ['bridge-relay.js'] });
    expect(calls[1]).toEqual({ tabId: 2, files: ['bridge-relay.js'] });
  });

  it('单 tab 注入失败只记日志，继续注入其余 tab（不抛出）', async () => {
    const logs: string[] = [];
    const injected: number[] = [];
    const recover = createRelayRecovery({
      queryTabs: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      executeScript: async (inj) => {
        // chrome:// 或已销毁 tab 会 reject：不能让单点失败中断整个恢复
        if (inj.target.tabId === 2) throw new Error('Cannot access contents of the page');
        injected.push(inj.target.tabId);
      },
      log: (msg) => logs.push(msg),
    });
    await expect(recover()).resolves.toBeUndefined();
    expect(injected).toEqual([1, 3]);
    expect(logs.some((l) => l.includes('tab 2'))).toBe(true);
    expect(logs.some((l) => l.includes('2/3'))).toBe(true);   // 汇总含成功计数
  });

  it('查询零 tab（如刚安装时没有开着的网页）→ 正常返回，不注入', async () => {
    const executeScript = vi.fn(async () => undefined);
    const recover = createRelayRecovery({
      queryTabs: async () => [],
      executeScript,
    });
    await expect(recover()).resolves.toBeUndefined();
    expect(executeScript).not.toHaveBeenCalled();
  });
});
