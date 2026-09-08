import type { AuthStatus } from '../background/providers/adapter';

export function formatAuthState(s: AuthStatus): { label: string; cls: 'ok' | 'warn' | 'bad' } {
  if (s.state === 'logged_in') return { label: '已登录', cls: 'ok' };
  if (s.state === 'expired') return { label: `登录失效：${s.message ?? ''}`, cls: 'warn' };
  return { label: '未登录（请在浏览器中登录 chat.deepseek.com）', cls: 'bad' };
}
