import { getPanelApi } from './panel-api';
import type { LogEntry } from '../../background/log';

export function mountSse(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <button data-refresh>刷新</button>
    <div data-groups style="margin-top:8px;"></div>
  `;
  const groupsEl = pane.querySelector('[data-groups]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;

  const groupBy = (logs: LogEntry[]): Map<string, LogEntry[]> => {
    const m = new Map<string, LogEntry[]>();
    for (const l of logs) {
      if (!l.webSessionId) continue;
      if (!m.has(l.webSessionId)) m.set(l.webSessionId, []);
      m.get(l.webSessionId)!.push(l);
    }
    return m;
  };

  const render = (): void => {
    const groups = groupBy(allLogs);
    groupsEl.innerHTML = [...groups.entries()].map(([ws, entries]) => {
      const start = new Date(entries[0]!.at).toLocaleTimeString();
      const sample = (entries[0]!.replySample ?? '').slice(0, 200);
      return `
        <details data-group style="margin:4px 0;border:1px solid #ddd;padding:4px;">
          <summary><b>${ws.slice(0, 16)}…</b> @${start} (${entries.length} entries) — ${sample}</summary>
          <div style="margin-left:16px;">
            ${entries.map(e => `<div style="padding:2px;font-family:ui-monospace,monospace;font-size:11px;">${new Date(e.at).toLocaleTimeString()} ${(e.replySample ?? '').slice(0, 120)}</div>`).join('')}
          </div>
        </details>
      `;
    }).join('') || '<p style="color:#888;">暂无 SSE 帧数据。</p>';
  };

  let allLogs: LogEntry[] = [];
  const refresh = async (): Promise<void> => {
    allLogs = await getPanelApi().listLogs();
    allLogs.sort((a, b) => b.at - a.at);
    render();
  };
  refreshBtn.addEventListener('click', () => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}