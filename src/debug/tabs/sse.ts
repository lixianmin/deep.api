import { getPanelApi } from './panel-api';
import { escapeHtml } from './log';
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
      // 2026-09-11（fix/review-r1）：entries 来自倒序排序后的 allLogs → entries[0] 是**最新**一条。
      // 旧实现把 entries[0].at 标成起始时间，语义写反；改为取组内最早（末尾）→ 最新。
      const oldestAt = entries[entries.length - 1]!.at;
      const newestAt = entries[0]!.at;
      const range = oldestAt === newestAt
        ? new Date(oldestAt).toLocaleTimeString()
        : `${new Date(oldestAt).toLocaleTimeString()}–${new Date(newestAt).toLocaleTimeString()}`;
      const sample = (entries[0]!.replySample ?? '').slice(0, 200);
      // 2026-09-11（diag/continue-thinking）：spike 期间显示响应截断定位字段——一眼看出是哪条 entry。
      const stats = entries[0]!.sseThinkingChars !== undefined
        ? `think=${entries[0]!.sseThinkingChars}c resp=${entries[0]!.sseResponseChars ?? 0}c status=${JSON.stringify(entries[0]!.sseStatusValues ?? [])}`
        : '';
      return `
        <details data-group style="margin:4px 0;border:1px solid #ddd;padding:4px;">
          <summary><b>${escapeHtml(ws.slice(0, 16))}…</b> @${range} (${entries.length} entries) — ${escapeHtml(sample)}${stats ? ` <span style="color:#a60;">${escapeHtml(stats)}</span>` : ''}</summary>
          <div style="margin-left:16px;">
            ${entries.map(e => {
              const tStats = e.sseThinkingChars !== undefined
                ? `think=${e.sseThinkingChars}c status=${JSON.stringify(e.sseStatusValues ?? [])}`
                : '';
              const rawTail = e.sseRawTail ? `<pre style="margin:2px 0;white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:4px;font-size:10px;">${escapeHtml(e.sseRawTail)}</pre>` : '';
              return `<div style="padding:2px;font-family:ui-monospace,monospace;font-size:11px;">${new Date(e.at).toLocaleTimeString()} ${escapeHtml((e.replySample ?? '').slice(0, 120))}${tStats ? ` <span style="color:#a60;">${escapeHtml(tStats)}</span>` : ''}${rawTail}</div>`;
            }).join('')}
          </div>
        </details>
      `;
    }).join('') || '<p style="color:#888;">暂无 SSE 帧数据。</p>';
  };

  let allLogs: LogEntry[] = [];
  const refresh = async (): Promise<void> => {
    // 2026-09-11（fix/review-r1）：失败不再静默（旧实现 void refresh() 吞掉 reject → tab 永久空白无提示）
    try {
      allLogs = await getPanelApi().listLogs();
      allLogs.sort((a, b) => b.at - a.at);
      render();
    } catch (e) {
      groupsEl.innerHTML = `<p style="color:#a00;">加载失败：${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
    }
  };
  refreshBtn.addEventListener('click', () => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}