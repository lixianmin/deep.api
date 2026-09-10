import { mountChat } from './tabs/chat';
import { mountRouting } from './tabs/routing';
import { mountLog } from './tabs/log';
import { mountSse } from './tabs/sse';
import { mountScenarios } from './tabs/scenarios';

const TABS = [
  { id: 'chat',       label: 'Chat',       mount: mountChat },
  { id: 'routing',    label: '路由',       mount: mountRouting },
  { id: 'log',        label: '日志',       mount: mountLog },
  { id: 'sse',        label: 'SSE 帧',     mount: mountSse },
  { id: 'scenarios',  label: '场景',       mount: mountScenarios },
] as const;

type TabId = typeof TABS[number]['id'];

export function mountDebugPanel(root: HTMLElement): () => void {
  // 每个 tab 只 mount 一次（首次激活时懒加载），切走用 display:none 隐藏、不卸载。
  // 这样 chat/scenarios 等的内部状态（历史、模型选择、滚动位置）切回时不丢。
  const mounted = new Map<TabId, { unmount: () => void; pane: HTMLElement }>();

  // nav 创建一次，按钮 active 状态随当前 tab 更新
  const nav = document.createElement('nav');
  nav.className = 'tab-nav';
  const navBtns = new Map<TabId, HTMLButtonElement>();
  for (const t of TABS) {
    const btn = document.createElement('button');
    btn.dataset.tab = t.id;
    btn.textContent = t.label;
    btn.addEventListener('click', () => { window.location.hash = '#' + t.id; });
    nav.appendChild(btn);
    navBtns.set(t.id, btn);
  }
  root.appendChild(nav);

  const currentHash = (): TabId => {
    const h = window.location.hash.replace(/^#/, '');
    return (TABS.find(t => t.id === h)?.id ?? 'chat') as TabId;
  };

  const setActive = (activeId: TabId): void => {
    // 隐藏所有已 mount 的 pane
    for (const [tid, m] of mounted) {
      m.pane.style.display = tid === activeId ? '' : 'none';
    }
    // 更新 nav active 状态
    for (const [tid, btn] of navBtns) {
      btn.dataset.active = String(tid === activeId);
    }
    // 懒加载：首次激活时 mount
    if (!mounted.has(activeId)) {
      const pane = document.createElement('section');
      pane.dataset.pane = activeId;
      const tab = TABS.find(t => t.id === activeId)!;
      const unmount = tab.mount(pane);
      root.appendChild(pane);
      mounted.set(activeId, { unmount, pane });
    }
  };

  setActive(currentHash());
  const onHashChange = (): void => setActive(currentHash());
  window.addEventListener('hashchange', onHashChange);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    for (const [, m] of mounted) m.unmount();
    mounted.clear();
    root.innerHTML = '';
  };
}