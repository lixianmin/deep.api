/**
 * ChatGPT provider 登录态检查。
 *
 * ChatGPT 的鉴权不在 SW 端——用户在浏览器里登录 chatgpt.com，cookie 由浏览器自动管理。
 * SW 端只能通过「是否有一个 chatgpt.com tab 在桥接」来判断登录态：
 *   - 有桥接（bridge.hasConnection()=true）→ 用户在浏览器里登录了 chatgpt.com，假定 logged_in
 *     （这里不主动探测页面态——避免探测脚本被反自动化拦）
 *   - 无桥接 → logged_out（提示用户打开 chatgpt.com 标签页）
 *
 * 这与 DeepSeek 用 token 探测的范式不同：DeepSeek 是 SW 端发请求看 200/401；ChatGPT
 * 是「bridge 存在 = 用户已登录浏览器」。如果未来 chatgpt.com 在用户登出后仍维持桥接，
 * 可以在此加一个 chatgpt.com 侧 ping（成本高，留待真有此 bug 再加）。
 */
import type { AuthStatus, ProviderContext } from '../adapter';
import type { ChatGPTBridge } from './adapter';

export const CHATGPT_LOGIN_PAGE = 'https://chatgpt.com/';

export async function getAuthStatus(ctx: ProviderContext, bridge: ChatGPTBridge): Promise<AuthStatus> {
  // token 字段无意义——ChatGPT 不在 SW 端走 token；ctx.token 通常为空串。这里用 hasConnection 判定。
  void ctx;
  return bridge.hasConnection() ? { state: 'logged_in' } : { state: 'logged_out' };
}