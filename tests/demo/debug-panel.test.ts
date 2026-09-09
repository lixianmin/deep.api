import { describe, it, expect, beforeEach } from 'vitest';
import { mountDebugPanel } from '../../src/demo/debug-panel';

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
});
