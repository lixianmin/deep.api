import type { AuthStatus } from '../background/providers/adapter';

/**
 * 2026-09-10（feat/log-b64-export）：现场取证的字段白名单（配合 pickForensic）。
 * 含三个 base64 字段：DSML 标记（｜DSML｜，U+FF5C）会被聊天/终端粘贴链吃掉，
 * base64 是纯 ASCII，能逐字节还原现场。
 */
export const FORENSIC_FIELDS = [
  'at', 'version', 'provider', 'model', 'ok', 'ms', 'error', 'finishReason',
  'cid', 'msgsLen', 'action', 'threadFound', 'mirrorLen', 'deletedOld', 'firstDiffIdx',
  'parentMessageId', 'sseBytes', 'ssePaths', 'requestFull',
  // 2026-09-11（diag/continue-thinking）：spike 期间临时加——thinking 截断定位用。
  'sseStatusValues', 'sseThinkingChars', 'sseResponseChars', 'sseRawTail', 'sseRawTailB64',
  'replySample', 'reasoningSample', 'replyB64', 'rawB64', 'sseRawB64',
] as const;

/**
 * 从一条日志里挑出取证字段（只保留有值的）。
 * 「复制」按钮把最近 200 条**完整**日志序列化（含 messagesFull / mirrorFull，可达 MB），
 * 贴给 AI 不现实；取证只需要模型原文与其 base64。白名单固定，杜绝两个大字段混进来。
 * 入参用宽松 Record：popup 本地的 LogEntry 类型是后台 LogEntry 的子集。
 */
export function pickForensic(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  for (const k of FORENSIC_FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
  return out;
}

/**
 * 取最近 n 条日志的取证字段（保持时间顺序）。
 * 2026-09-10（fix/forensic-tail）：单个「最新一条」会取错——Spice 一轮会发多次请求
 * （聊天调用之后还有「生成会话标题」辅助调用），最新一条往往不是出问题的那一条。
 * 取尾 n 条既能看到整轮的时序，也能把真正的失败调用包进来。n 默认 5。
 */
export function pickForensicTail(entries: Record<string, unknown>[] | undefined, n = 5): Record<string, unknown>[] {
  if (!entries?.length) return [];
  return entries.slice(-n).map(pickForensic);
}

export function formatAuthState(s: AuthStatus): { label: string; cls: 'ok' | 'warn' | 'bad' } {
  if (s.state === 'logged_in') return { label: '已登录', cls: 'ok' };
  if (s.state === 'expired') return { label: `登录失效：${s.message ?? ''}`, cls: 'warn' };
  return { label: '未登录（请在浏览器中登录 chat.deepseek.com）', cls: 'bad' };
}

/** popup 渲染用的日志条目（后台 LogEntry 的子集）。 */
export interface PopupLogEntry {
  at: number;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
  cid?: string;
  msgsLen?: number;
  action?: 'rebuild' | 'incremental' | 'error';
  threadFound?: boolean;
  mirrorLen?: number;
  deletedOld?: boolean;
  webSessionId?: string;
  parentMessageId?: string | number | null;
  finishReason?: string;
  firstDiffIdx?: number;
}

/** HTML 转义。
 *  2026-09-11（fix/review-r1）：popup 的日志/模型列表字段直插 innerHTML——`cid` 来自调用方传入的
 *  conversation_id、`error` 含 page 可控的 image_url，而 bridge-main 注入 <all_urls> 的任意网页
 *  都能往 SW 环形日志写内容，popup 每 2s 重渲染 → 任意 HTML/DOM 注入（恶意 img 请求 / UI 钓鱼）。
 *  MV3 CSP 挡得住脚本执行，但不挡 HTML 注入。所有插值必须过本函数。 */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 模型列表（description 来自 catalog label，页面可控）。 */
export function renderModelListHtml(models: Array<{ id: string; description?: string }>): string {
  if (!models.length) return '<li class="small">（需登录后获取）</li>';
  return models
    .map((m) => `<li><code>${escapeHtml(m.id)}</code> <span class="small">${escapeHtml(m.description ?? '')}</span></li>`)
    .join('');
}

/** 日志列表（已按展示顺序排好的条目）。所有字段转义后再拼 HTML。 */
export function renderLogListHtml(entries: PopupLogEntry[]): string {
  return entries.map((e) => {
    const okCls = e.ok ? 'ok' : 'err';
    const okMark = e.ok ? '✓' : '✗';
    const actionBadge = e.action === 'incremental' ? '<span class="ok">增量</span>'
      : e.action === 'rebuild' ? `<span class="err">重建</span>${e.deletedOld ? ' <span class="err" title="rebuild 删了旧 web session">🗑️</span>' : ''}`
      : '';
    const detailParts: string[] = [];
    if (e.cid) detailParts.push(`cid=${escapeHtml(e.cid)}`);
    if (e.threadFound === false) detailParts.push('<span class="err">thread 未找到</span>');
    if (e.mirrorLen !== undefined) detailParts.push(`mirrorLen=${e.mirrorLen}`);
    if (e.msgsLen !== undefined) detailParts.push(`msgs=${e.msgsLen}`);
    if (e.webSessionId) detailParts.push(`web=${escapeHtml(e.webSessionId.slice(0, 8))}…`);
    if (e.parentMessageId !== undefined && e.parentMessageId !== null) detailParts.push(`parent=${escapeHtml(String(e.parentMessageId).slice(0, 8))}`);
    if (e.finishReason) detailParts.push(`finish=${escapeHtml(e.finishReason)}`);
    if (e.error) detailParts.push(`<span class="err">err=${escapeHtml(e.error.slice(0, 80))}</span>`);
    if (e.firstDiffIdx !== undefined) detailParts.push(`<span class="err">diff@${e.firstDiffIdx}</span>`);
    return `<li><span class="${okCls}">${okMark}</span> ${new Date(e.at).toLocaleTimeString()} ${escapeHtml(e.provider)}/${escapeHtml(e.model)} ${e.ms}ms ${actionBadge} <span class="small">${detailParts.join(' ')}</span></li>`;
  }).join('');
}
