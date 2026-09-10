import { describe, it, expect, vi } from 'vitest';
import { runAllScenarios, probeToolFormat } from '../../../src/debug/tabs/scenarios';

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

// 2026-09-10（diag/tool-format-probe）：判定场景的检测逻辑必须可靠——它错了整个实验就会误导。
describe('probeToolFormat', () => {
  const probeResponse = (content: string, toolCalls?: any[]): any => ({
    choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
  });

  it('跑 4 个探针；标准 <tool_calls> 被剥离时 dsml=false，XML DSML 残留时 dsml=true', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(probeResponse('', [{ function: { name: 'get_weather' } }]))                        // 1 tool / 1 call → 标准 JSON（已剥离）
      .mockResolvedValueOnce(probeResponse('<|dsml|tool_calls>\n<|dsml|invoke name="get_weather">'))            // 1 tool / 2 calls → XML DSML 残留
      .mockResolvedValueOnce(probeResponse('', [{ function: { name: 'Read' } }]))
      .mockResolvedValueOnce(probeResponse('', [{ function: { name: 'Read' } }, { function: { name: 'Read' } }, { function: { name: 'Read' } }]));
    (globalThis as any).deepApi = { chat: { completions: { create } } };

    const out = await probeToolFormat('m1', {});

    expect(create).toHaveBeenCalledTimes(4);
    expect(out).toContain('[1 tool  / 2 calls] finish=stop calls=0 dsml=true');
    expect(out).toContain('[5 tools / 3 calls] finish=tool_calls calls=3');
    // 探针 1（标准格式）不误报；探针 2（XML 残留）必须报出来
    expect(out.split('\n').filter((l) => l.includes('dsml=true'))).toHaveLength(1);
    expect(out).toContain('dsml=true');
    expect(out).toContain('invoke name=');
  });

  it('单个探针抛错不中断其余探针，结果里带 ERROR', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('provider_unavailable'))
      .mockResolvedValue(probeResponse('', [{ function: { name: 'get_weather' } }]));
    (globalThis as any).deepApi = { chat: { completions: { create } } };
    const out = await probeToolFormat('m1', {});
    expect(create).toHaveBeenCalledTimes(4);
    expect(out).toContain('ERROR provider_unavailable');
  });
});
