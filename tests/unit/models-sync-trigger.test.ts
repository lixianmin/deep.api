// 2026-09-14（fix/models-v4-retired）：content script trigger 测试。
// 必须在 import 之前设 __MODELS_SYNC_TEST=true 跳过发布副作用（默认 15×1s poll 阻塞测试）。
(globalThis as { __MODELS_SYNC_TEST?: boolean }).__MODELS_SYNC_TEST = true;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startWith } from '../../src/content/models-sync';

// 跨测试隔离：每次 beforeEach 重置 document / location / chrome
const resetTestEnv = (): void => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'location', { value: { hostname: 'chat.deepseek.com' }, configurable: true, writable: true });
  (globalThis as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn() },
  };
};

describe('content script trigger on chat.deepseek.com (2026-09-14 fix/models-v4-retired)', () => {
  beforeEach(resetTestEnv);

  it('extracts + sends when the model trigger is present', async () => {
    document.body.innerHTML = `
      <button data-testid="model-trigger">current</button>
      <div role="listbox">
        <div role="option">default</div>
        <div role="option">DeepSeek V4.1 Flash</div>
      </div>
    `;
    startWith({ pollIntervalMs: 5, pollMaxTries: 10, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 200));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    const calls = send.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1]![0] as { method: string; models: { label: string }[] };
    expect(lastCall).toMatchObject({ method: 'models-catalog:update' });
    const labels = lastCall.models.map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(['default', 'DeepSeek V4.1 Flash']));
  });

  it('does not throw and does not send when no trigger present', async () => {
    document.body.innerHTML = '<div>nothing</div>';
    startWith({ pollIntervalMs: 5, pollMaxTries: 3, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 100));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    expect(send.mock.calls.length).toBe(0);
  });

  it('does nothing on non-deepseek hostnames', async () => {
    (window as { location: { hostname: string } }).location.hostname = 'example.com';
    document.body.innerHTML = `
      <button data-testid="model-trigger">x</button>
      <div role="listbox"><div role="option">default</div></div>
    `;
    startWith({ pollIntervalMs: 5, pollMaxTries: 3, clickSettleMs: 5, retryDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const send = ((globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage);
    expect(send).not.toHaveBeenCalled();
  });
});
