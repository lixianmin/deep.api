import { getPanelApi } from './panel-api';
import type { ThreadRow } from '../../background/session-mapper';

const REL = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return Math.floor(diff / 1000) + ' 秒前';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  return Math.floor(diff / 3_600_000) + ' 小时前';
};

export function mountRouting(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <button data-refresh>刷新</button>
    <table border="1" cellpadding="4" style="border-collapse:collapse;margin-top:8px;font-size:12px;">
      <thead><tr><th>conversationId</th><th>kind</th><th>mirrorLen</th><th>lastDecision</th><th>lastUsedAt</th><th>busy</th><th>webSessionId</th></tr></thead>
      <tbody data-tbody></tbody>
    </table>
    <p data-empty style="display:none;color:#888;">暂无 thread——发起一次 Chat 或场景调用后会出现在此。</p>
  `;
  const tbody = pane.querySelector('[data-tbody]')!;
  const empty = pane.querySelector('[data-empty]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;

  const render = (rows: ThreadRow[]): void => {
    if (rows.length === 0) { tbody.innerHTML = ''; (empty as HTMLElement).style.display = ''; return; }
    (empty as HTMLElement).style.display = 'none';
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.conversationId}</td>
        <td>${r.kind}</td>
        <td>${r.mirrorLen}</td>
        <td>${r.lastDecision ?? ''}</td>
        <td>${REL(r.lastUsedAt)}</td>
        <td>${r.busy}</td>
        <td>${r.webSessionId.slice(0, 12)}…</td>
      </tr>
    `).join('');
  };

  const refresh = async (): Promise<void> => {
    const rows = await getPanelApi().listThreads();
    render(rows);
  };

  refreshBtn.addEventListener('click', () => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}