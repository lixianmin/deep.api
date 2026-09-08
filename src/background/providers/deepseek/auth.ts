import type { AuthStatus, ProviderContext } from '../adapter';

export const DEEPSEEK_LOGIN_PAGE = 'https://chat.deepseek.com/';
export const DEEPSEEK_COOKIE_DOMAIN = 'chat.deepseek.com';
export const DEEPSEEK_COOKIES = ['user_token'];   // spike 实测核准（待 Task 2 spike 校准）

export async function getAuthStatus(
  ctx: ProviderContext,
  probe: (c: ProviderContext) => Promise<boolean>,
): Promise<AuthStatus> {
  if (!ctx.token) return { state: 'logged_out' };
  try {
    return (await probe(ctx)) ? { state: 'logged_in' } : { state: 'expired', message: 'token invalid' };
  } catch (e) {
    return { state: 'expired', message: (e as Error).message };
  }
}
