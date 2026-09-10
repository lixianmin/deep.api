import { describe, it, expect, vi } from 'vitest';
import { extractModelOptions, labelToModelId, sendCatalogUpdate } from '../../src/content/models-sync';

describe('labelToModelId', () => {
  it('maps "DeepSeek V4 Flash" → "deepseek-v4-flash"', () => {
    expect(labelToModelId('DeepSeek V4 Flash')).toBe('deepseek-v4-flash');
  });
  it('maps "DeepSeek V4 Pro" → "deepseek-v4-pro"', () => {
    expect(labelToModelId('DeepSeek V4 Pro')).toBe('deepseek-v4-pro');
  });
  it('maps "DeepSeek V4 Flash Vision Exp" → "deepseek-v4-flash-vision-exp"', () => {
    expect(labelToModelId('DeepSeek V4 Flash Vision Exp')).toBe('deepseek-v4-flash-vision-exp');
  });
  it('returns null for unknown labels', () => {
    expect(labelToModelId('Some Future Model')).toBeNull();
  });
});

describe('extractModelOptions', () => {
  function mountSelector(html: string) {
    document.body.innerHTML = html;
  }
  it('scrapes [role="option"] children of an open dropdown', async () => {
    mountSelector(`
      <button data-testid="model-trigger">Current</button>
      <div role="listbox">
        <div role="option">DeepSeek V4 Flash</div>
        <div role="option">DeepSeek V4 Pro</div>
        <div role="option">DeepSeek V4 Flash Vision Exp</div>
      </div>
    `);
    const opts = await extractModelOptions();
    expect(opts).toEqual([
      { label: 'DeepSeek V4 Flash' },
      { label: 'DeepSeek V4 Pro' },
      { label: 'DeepSeek V4 Flash Vision Exp' },
    ]);
  });
  it('returns [] when no dropdown present', async () => {
    mountSelector(`<div>nothing relevant</div>`);
    expect(await extractModelOptions()).toEqual([]);
  });
  // 2026-09-10（feat/models-sync）：jsdom textContent 含空白 trim
  it('trims whitespace from option labels', async () => {
    mountSelector(`
      <div role="listbox">
        <div role="option">
          DeepSeek V4 Flash
        </div>
      </div>
    `);
    const opts = await extractModelOptions();
    expect(opts).toEqual([{ label: 'DeepSeek V4 Flash' }]);
  });
});

// 2026-09-10（feat/models-sync）：Task 2 — content script → SW 消息桥。
// preflight ruling：使用 bridge 协议 `method:` 字段（不是 `kind:`），
// 与 src/shared/protocol.ts isBridgeRequest + sw.ts port.onMessage 一致。
describe('sendCatalogUpdate', () => {
  it('posts models-catalog:update to chrome.runtime.sendMessage with method field', () => {
    const send = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
    sendCatalogUpdate([{ label: 'DeepSeek V4 Flash' }]);
    expect(send).toHaveBeenCalledWith({
      method: 'models-catalog:update',
      models: [{ label: 'DeepSeek V4 Flash' }],
    });
    vi.unstubAllGlobals();
  });

  it('does not throw when chrome.runtime is undefined (e.g. non-extension context)', () => {
    vi.stubGlobal('chrome', undefined);
    expect(() => sendCatalogUpdate([{ label: 'x' }])).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('does not throw when chrome.runtime.sendMessage throws', () => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: () => { throw new Error('port dead'); } } });
    expect(() => sendCatalogUpdate([{ label: 'x' }])).not.toThrow();
    vi.unstubAllGlobals();
  });
});