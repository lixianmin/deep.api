import { getPanelApi } from './panel-api';
import type { LogEntry } from '../../background/log';

/** HTML 转义（本文件所有直插 innerHTML 的字段都要过它）。
 *  2026-09-11（fix/review-r1）：日志字段（cid/provider/model/replySample 等）部分来自调用方与模型
 *  输出（conv_id 由页面传入、replySample 是模型原文）——不转义 = 任何被访问的网页都能往 chrome-extension://
 *  源里注入 HTML。原本只对 sseRaw/requestFull 转义，其余漏了。sse.ts / routing.ts 也从这里导入复用。 */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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
      // 2026-09-11（fix/review-r1）：reply 只取 replySample。旧实现 `replySample ?? error` 让
      // 「失败且同时有模型输出」的请求（DSML 解析 400 / 工具修复失败现场必中）永远看不到 error，
      // 而这正是最需要看失败原因的场景。error 改为单独一块（下面）。
      const reply = (l.replySample ?? '').slice(0, 100);
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
          <span style="margin-left:8px;">${escapeHtml(l.provider)}</span>
          <span style="margin-left:8px;">${escapeHtml(l.model)}</span>
          <span style="margin-left:8px;color:${l.ok ? '#0a0' : '#a00'};">${l.ok ? 'ok' : 'err'}</span>
          <span style="margin-left:8px;">${l.ms}ms</span>
          <span style="margin-left:8px;">${escapeHtml(l.action ?? '')}</span>
          <span style="margin-left:8px;color:#666;">${escapeHtml(l.cid ?? '')}</span>
          <button data-copy="${i}" style="float:right;">复制完整 JSON</button>
        </div>
        ${l.error ? `<div style="margin-left:8px;margin-top:2px;"><span style="color:#888;">error:</span><span style="margin-left:4px;color:#a00;">${escapeHtml(l.error)}</span></div>` : ''}
        ${(l.warnings ?? []).map((w) => `<div style="margin-left:8px;margin-top:2px;"><span style="color:#888;">warn:</span><span style="margin-left:4px;color:#a60;">${escapeHtml(w)}</span></div>`).join('')}
        <div style="margin-left:8px;margin-top:2px;">
          <span style="color:#888;">reply:</span>
          <span style="margin-left:4px;">${escapeHtml(reply) || '(空)'}</span>
        </div>
        <div style="margin-left:8px;margin-top:2px;${reasonStyle}">
          <span style="color:#888;">💭reason:</span>
          <span style="margin-left:4px;">${escapeHtml(reason) || '(空)'}</span>
        </div>
        <div style="margin-left:8px;margin-top:2px;${bytesStyle}">
          <span style="color:#888;">sse:</span>
          <span style="margin-left:4px;">${bytes}B</span>
          <span style="margin-left:8px;color:#888;">paths:</span>
          <span style="margin-left:4px;">${escapeHtml(paths.length ? paths.join(', ') : '(none)')}</span>
        </div>
        ${(l.sseRaw ?? '') ? `<div style="margin-left:8px;margin-top:2px;color:#888;max-width:900px;word-break:break-all;">raw: ${escapeHtml(l.sseRaw!.slice(0, 400))}</div>` : ''}
        ${(l.requestFull ?? '') ? `<div style="margin-left:8px;margin-top:2px;color:#888;max-width:900px;word-break:break-all;">req: ${escapeHtml(l.requestFull!)}</div>` : ''}
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
    // 2026-09-11（fix/review-r1）：失败不再静默（旧实现 void refresh() 吞掉 reject → tab 永久空白无提示）
    try {
      allLogs = await getPanelApi().listLogs();
      allLogs.sort((a, b) => b.at - a.at);
      render();
    } catch (e) {
      listEl.innerHTML = `<div style="color:#a00;padding:4px;">加载失败：${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    }
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
