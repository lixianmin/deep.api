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
