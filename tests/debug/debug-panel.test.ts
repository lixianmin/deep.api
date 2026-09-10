import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountDebugPanel } from '../../src/debug/debug-panel';

// Task 5 起 routing tab 调 getPanelApi() → chrome.runtime.connect。
// 本文件只测 debug-panel 的 tab 框架，不验 panel-api 行为；给 chrome 一个 no-op stub 即可，
// 避免 'URL hash 切换激活态' 用例激活 routing tab 时抛 ReferenceError。
(globalThis as any).chrome = {
  runtime: {
    connect: vi.fn(() => ({
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    })),
  },
};

describe('mountDebugPanel', () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });

  it('渲染 5 个 tab', () => {
    mountDebugPanel(root);
    expect(root.querySelectorAll('[data-tab]')).toHaveLength(5);
    const ids = ['chat', 'routing', 'log', 'sse', 'scenarios'];
    ids.forEach(id => expect(root.querySelector(`[data-tab="${id}"]`)).toBeTruthy());
  });

  it('默认激活 chat tab', () => {
    mountDebugPanel(root);
    expect(root.querySelector('[data-tab="chat"]')!.getAttribute('data-active')).toBe('true');
    expect(root.querySelector('[data-tab="routing"]')!.getAttribute('data-active')).toBe('false');
  });

  it('URL hash 切换激活态', () => {
    window.location.hash = '#routing';
    mountDebugPanel(root);
    expect(root.querySelector('[data-tab="routing"]')!.getAttribute('data-active')).toBe('true');
    expect(root.querySelector('[data-tab="chat"]')!.getAttribute('data-active')).toBe('false');
  });

  it('返回的 unmount 函数清空 root', () => {
    const unmount = mountDebugPanel(root);
    unmount();
    expect(root.innerHTML).toBe('');
  });

  it('切到 log tab 再切回 chat，chat pane 实例不重建（state 保留）', () => {
    window.location.hash = '#chat';
    mountDebugPanel(root);
    const chatPaneBefore = root.querySelector('section[data-pane="chat"]');
    expect(chatPaneBefore).toBeTruthy();
    window.location.hash = '#log';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('section[data-pane="chat"]')).toBe(chatPaneBefore);
    window.location.hash = '#chat';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(root.querySelector('section[data-pane="chat"]')).toBe(chatPaneBefore);
  });

  it('切到其他 tab 再切回，每个 pane 只 mount 一次（同一节点）', () => {
    window.location.hash = '#chat';
    mountDebugPanel(root);
    const chatPane = root.querySelector('section[data-pane="chat"]')!;
    window.location.hash = '#log';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.location.hash = '#scenarios';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.location.hash = '#chat';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // 切回 chat 后节点是同一个（不是被销毁重建的）
    expect(root.querySelector('section[data-pane="chat"]')).toBe(chatPane);
    // log/scenarios 也已经被懒加载挂载
    expect(root.querySelector('section[data-pane="log"]')).toBeTruthy();
    expect(root.querySelector('section[data-pane="scenarios"]')).toBeTruthy();
    // 未访问的 routing/sse 仍未挂载
    expect(root.querySelector('section[data-pane="routing"]')).toBeNull();
    expect(root.querySelector('section[data-pane="sse"]')).toBeNull();
  });

  it('只显示 active pane（隐藏的 pane display:none）', () => {
    window.location.hash = '#chat';
    mountDebugPanel(root);
    window.location.hash = '#log';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const chatPane = root.querySelector<HTMLElement>('section[data-pane="chat"]')!;
    const logPane = root.querySelector<HTMLElement>('section[data-pane="log"]')!;
    expect(chatPane.style.display).toBe('none');
    expect(logPane.style.display).toBe('');
  });
});
