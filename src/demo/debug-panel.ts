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
  let currentUnmount: (() => void) | null = null;
  const currentHash = (): TabId => {
    const h = window.location.hash.replace(/^#/, '');
    return (TABS.find(t => t.id === h)?.id ?? 'chat') as TabId;
  };

  const render = (activeId: TabId): void => {
    // unmount 旧的
    if (currentUnmount) { currentUnmount(); currentUnmount = null; }
    root.innerHTML = '';

    // tab 栏
    const nav = document.createElement('nav');
    nav.className = 'tab-nav';
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.dataset.active = String(t.id === activeId);
      btn.addEventListener('click', () => { window.location.hash = '#' + t.id; });
      nav.appendChild(btn);
    }
    root.appendChild(nav);

    // active tab 内容容器
    const pane = document.createElement('section');
    pane.dataset.pane = activeId;
    root.appendChild(pane);

    const tab = TABS.find(t => t.id === activeId)!;
    currentUnmount = tab.mount(pane);
  };

  render(currentHash());
  const onHashChange = (): void => render(currentHash());
  window.addEventListener('hashchange', onHashChange);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    if (currentUnmount) currentUnmount();
    root.innerHTML = '';
  };
}
