import { describe, it, expect, vi } from 'vitest';
import { runAllScenarios } from '../../../src/debug/tabs/scenarios';

// 最小 SSE body：stream 场景读 res.body.getReader()。brief 自带的 mock 不带 body，
// 与 brief 的 stream 场景实现不一致；为使 6 个场景在统一 mock 下都能跑通，
// 按 Task 4 chat.test.ts 模式补一个空 ReadableStream（与 brief 测试语义一致：全部 6 个 ok）。
const emptySse = new ReadableStream<Uint8Array>({
  start(controller) { controller.close(); },
});
const okResponse = (): any => ({ body: emptySse, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });

describe('runAllScenarios', () => {
  it('顺序跑完 6 个场景，全部通过', async () => {
    const api = {
      chat: { completions: { create: vi.fn().mockResolvedValue(okResponse()) } },
    };
    (globalThis as any).deepApi = api;
    const results = await runAllScenarios('m1', {}, () => false);
    expect(results).toHaveLength(6);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('软取消：跑到第 3 个后取消，剩 3 个结果', async () => {
    const api = {
      chat: { completions: { create: vi.fn().mockResolvedValue(okResponse()) } },
    };
    (globalThis as any).deepApi = api;
    let calls = 0;
    const onCancelRequested = (): boolean => { calls++; return calls > 3; };  // 第 4 次调用时返回 true
    const results = await runAllScenarios('m1', {}, onCancelRequested);
    expect(results.length).toBeLessThan(6);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('某场景失败不中断后续，结果表标红', async () => {
    let i = 0;
    const api = {
      chat: { completions: { create: vi.fn().mockImplementation(() => {
        i++; if (i === 2) throw new Error('boom');
        return Promise.resolve(okResponse());
      }) } },
    };
    (globalThis as any).deepApi = api;
    const results = await runAllScenarios('m1', {}, () => false);
    expect(results.find(r => !r.ok)?.name).toBeTruthy();
    expect(results.length).toBe(6);  // 失败也跑完
  });
});
