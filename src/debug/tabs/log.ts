import { getPanelApi } from './panel-api';
import type { LogEntry } from '../../background/log';

const ACTIONS = ['rebuild', 'incremental', 'error', 'undefined'] as const;

export function mountLog(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <div data-filter data-filter-action style="margin-bottom:8px;">
      <span>action:</span>
      ${ACTIONS.map(a => `<label><input type="checkbox" data-filter-action-${a} value="${a}">${a}</label>`).join('')}
      <span style="margin-left:12px;">ok:</span>
      <label><input type="checkbox" data-filter-ok value="ok">ok</label>
      <label><input type="checkbox" data-filter-err value="err">err</label>
      <span style="margin-left:12px;">search:</span>
      <input type="text" data-search placeholder="error / reply / reason / cid">
      <button data-refresh>刷新</button>
    </div>
    <div data-list style="max-height:60vh;overflow:auto;border:1px solid #ddd;"></div>
  `;
  const listEl = pane.querySelector('[data-list]')!;
  const searchEl = pane.querySelector<HTMLInputElement>('[data-search]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const actionCbs: Record<string, HTMLInputElement> = {};
  for (const a of ACTIONS) actionCbs[a] = pane.querySelector(`[data-filter-action-${a}]`)!;
  const okCb = pane.querySelector<HTMLInputElement>('[data-filter-ok]')!;
  const errCb = pane.querySelector<HTMLInputElement>('[data-filter-err]')!;

  let allLogs: LogEntry[] = [];

  const filter = (): LogEntry[] => {
    const allowedActions = (Object.entries(actionCbs).filter(([, cb]) => cb.checked).map(([a]) => a) as string[]);
    const okChecked = okCb.checked;
    const errChecked = errCb.checked;
    const q = searchEl.value.trim().toLowerCase();
    return allLogs.filter(l => {
      if (allowedActions.length > 0 && !allowedActions.includes(String(l.action ?? 'undefined'))) {
        return false;
      }
      if (okChecked && !l.ok) return false;
      if (errChecked && l.ok) return false;
      if (q) {
        const hay = ((l.error ?? '') + ' ' + (l.replySample ?? '') + ' ' + (l.reasoningSample ?? '') + ' ' + (l.ssePaths?.join(' ') ?? '') + ' ' + (l.cid ?? '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  };

  const render = (): void => {
    const rows = filter();
    listEl.innerHTML = rows.map((l, i) => {
      const t = new Date(l.at).toLocaleTimeString();
      const reason = (l.reasoningSample ?? '').slice(0, 100);
      const reply = (l.replySample ?? l.error ?? '').slice(0, 100);
      // 2026-09-09（diag/pro-sse-paths）：bytes/paths 列——判 Pro 场景 B-1/B-2/B-3
      const bytes = l.sseBytes ?? 0;
      const paths = l.ssePaths ?? [];
      // Pro 风格「只返 reasoning 不返 content」现场一眼看见：reason 行有内容、reply 行空
      const reasonStyle = reason ? 'color:#a60;background:#fff8e8;' : 'color:#ccc;';
      // Pro 场景颜色：bytes>0 但 paths 只有 fragments → 橙提示（疑 B-1）
      const bytesStyle = bytes === 0 ? 'color:#a00;' : paths.some((p) => p === 'response/fragments' || p === 'response/fragments/-1/content') && !paths.includes('response/content') ? 'color:#a60;' : 'color:#888;';
      return `<div data-row style="padding:4px;border-bottom:1px solid #eee;font-family:ui-monospace,monospace;font-size:11px;">
        <div>
          <span style="color:#888;">${t}</span>
          <span style="margin-left:8px;">${l.provider}</span>
          <span style="margin-left:8px;">${l.model}</span>
          <span style="margin-left:8px;color:${l.ok ? '#0a0' : '#a00'};">${l.ok ? 'ok' : 'err'}</span>
          <span style="margin-left:8px;">${l.ms}ms</span>
          <span style="margin-left:8px;">${l.action ?? ''}</span>
          <span style="margin-left:8px;color:#666;">${l.cid ?? ''}</span>
          <button data-copy="${i}" style="float:right;">复制完整 JSON</button>
        </div>
        <div style="margin-left:8px;margin-top:2px;">
          <span style="color:#888;">reply:</span>
          <span style="margin-left:4px;">${reply || '(空)'}</span>
        </div>
        <div style="margin-left:8px;margin-top:2px;${reasonStyle}">
          <span style="color:#888;">💭reason:</span>
          <span style="margin-left:4px;">${reason || '(空)'}</span>
        </div>
        <div style="margin-left:8px;margin-top:2px;${bytesStyle}">
          <span style="color:#888;">sse:</span>
          <span style="margin-left:4px;">${bytes}B</span>
          <span style="margin-left:8px;color:#888;">paths:</span>
          <span style="margin-left:4px;">${paths.length ? paths.join(', ') : '(none)'}</span>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.copy);
        navigator.clipboard.writeText(JSON.stringify(rows[i], null, 2));
      });
    });
  };

  const refresh = async (): Promise<void> => {
    allLogs = await getPanelApi().listLogs();
    allLogs.sort((a, b) => b.at - a.at);
    render();
  };
  refreshBtn.addEventListener('click', () => { void refresh(); });
  searchEl.addEventListener('input', render);
  for (const a of ACTIONS) actionCbs[a]!.addEventListener('change', render);
  okCb.addEventListener('change', render);
  errCb.addEventListener('change', render);
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}
