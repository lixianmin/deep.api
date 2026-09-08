import type { AuthStatus, ProviderContext } from '../adapter';

export const DEEPSEEK_LOGIN_PAGE = 'https://chat.deepseek.com/';
// DeepSeek web 可能使用的 cookie 名（spike 任务 #2 校准）。chrome.cookies 取 cookie 时域名必须用 . 前缀。
export const DEEPSEEK_COOKIE_NAMES = ['userToken', 'user_token', 'ds_session', 'sessionid'] as const;

/** 根据 ProviderContext 的 token 决定登录态。probe 是适配器自己发探测请求验证 token 有效。 */
export async function getAuthStatus(
  ctx: ProviderContext,
  probe: (c: ProviderContext) => Promise<boolean>,
): Promise<AuthStatus> {
  if (!ctx.token) return { state: 'logged_out' };
  try {
    return (await probe(ctx)) ? { state: 'logged_in' } : { state: 'expired', message: 'token invalid' };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    const status = (e as { status?: number })?.status;
    if (status === 401) return { state: 'expired', message: '登录已失效（401）' };
    if (status === 403) return { state: 'expired', message: '权限不足（403）' };
    return { state: 'expired', message: msg || '探测失败' };
  }
}
