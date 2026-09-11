// src/background/auth-sync.ts — auth.sync token 采纳策略（fix/auth-flip-flop）。
//
// 背景（2026-09-15 用户实测故障）：bridge-main 在每个 deepseek.com 页面每 5s 推送本页 localStorage
// 的 userToken；当两个来源持有不同 token（一个永久过期、一个有效）时，SW 旧的"变了就收"策略会让
// 缓存每 ~5s 翻转一次，翻转到的半个周期里所有请求 401/40003（调用方表现为"经常定期登录失败"）。
//
// 本模块把采纳决策收拢为可单测的纯逻辑（sw.ts 只做存储/广播接线），两层防御：
// 1) 坏名单：近期探测为 expired 的 token，窗口内重复推送直接拒绝，不再重复探测（省服务端 session 建/删）。
// 2) 好窗口：缓存 token 近期探测为 logged_in 时，不同的 incoming 必须先探测，expired 不得顶替。
// 窗口都有期限：token 可能复苏/缓存可能真的失效，超窗后回退为"照实采纳页面推送"。

export interface AuthStatus { state: string; message?: string }

export type AuthSyncAction =
  | 'accepted'
  | 'ignored-null'
  | 'ignored-unchanged'
  | 'rejected-known-bad'
  | 'rejected-expired-vs-good';

export interface AuthSyncDeps {
  loadCachedToken(): Promise<string | null>;
  setCachedToken(t: string | null): Promise<void>;
  /** 用给定 token 实际探测 DeepSeek 登录态（chat_session/create + delete） */
  probeToken(t: string | null): Promise<AuthStatus>;
}

export type AuthSyncResult =
  | { action: 'accepted'; status: AuthStatus }   // status：采纳过程中已探测到的登录态（sw.ts 直接落盘，不再二次探测）
  | { action: Exclude<AuthSyncAction, 'accepted'> };

// 为什么 10min：坏 token 一般是过期登录残留，短窗口内不会自愈；窗口内重复推送不再重复探测，
// 避免每 5s 白白在服务端建/删 session。窗口有限期：token 可能复苏（如重登同一 value），不永久拉黑。
export const BAD_TTL_MS = 10 * 60_000;
// 为什么 10min：缓存 token 在该窗口内探测过 logged_in 即视为可信，过期 token 不得顶替；
// 超窗后信任失效，回退为照实采纳（此时无法确知缓存 token 是否仍有效，不瞎拦）。
export const GOOD_TTL_MS = 10 * 60_000;
// 坏名单容量上限：防多个坏来源长期推送把 Map 撑大；淘汰最早入名单的条目。
const BAD_LIST_MAX = 8;

export function createAuthSync(deps: AuthSyncDeps, now: () => number = Date.now) {
  const bad = new Map<string, number>();   // token → 探测为 expired 的时刻
  let good: { token: string; at: number } | null = null;

  function trimBad(): void {
    while (bad.size > BAD_LIST_MAX) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, at] of bad) if (at < oldestAt) { oldestAt = at; oldestKey = k; }
      if (oldestKey === undefined) break;
      bad.delete(oldestKey);
    }
  }

  /** 探测结果记入守卫状态：logged_in 记好窗口，expired 记坏名单 */
  function record(token: string | null, status: AuthStatus): void {
    if (!token) return;
    if (status.state === 'logged_in') good = { token, at: now() };
    else if (status.state === 'expired') { bad.set(token, now()); trimBad(); }
  }

  /** 探测当前缓存 token 并回报守卫（sw.ts 的 refreshAuthAndLog / onInstalled / onStartup 复用） */
  async function probeCached(): Promise<AuthStatus> {
    const t = await deps.loadCachedToken();
    const st = await deps.probeToken(t);
    record(t, st);
    return st;
  }

  /** auth.sync 主流程：决定 incoming token 是采纳还是拒绝，采纳时附带已探测的登录态 */
  async function handleSync(newTok: string | null): Promise<AuthSyncResult> {
    const prev = await deps.loadCachedToken();
    // 防御：null token 不立即清缓存（可能来自页面误推或 token 轮换瞬态），保留最后一次有效 token
    if (newTok === null && prev !== null) return { action: 'ignored-null' };
    if (newTok === prev) return { action: 'ignored-unchanged' };

    let probedStatus: AuthStatus | null = null;
    // 坏名单：窗口内直接拒绝，不再探测（第一次探测已证明它过期）
    const badAt = newTok !== null ? bad.get(newTok) : undefined;
    if (badAt !== undefined && now() - badAt < BAD_TTL_MS) return { action: 'rejected-known-bad' };
    // 好窗口：缓存近期验证过 logged_in → incoming 必须先自证，expired 不得顶替
    if (newTok !== null && good && good.token === prev && now() - good.at < GOOD_TTL_MS) {
      probedStatus = await deps.probeToken(newTok);
      if (probedStatus.state === 'expired') {
        bad.set(newTok, now());
        trimBad();
        return { action: 'rejected-expired-vs-good' };
      }
    }

    await deps.setCachedToken(newTok);
    // status 尽量复用 incoming 探测结果；没有探测过（无守卫直接采纳）才补一发缓存探测
    const status = probedStatus ?? (await probeCached());
    return { action: 'accepted', status };
  }

  return { handleSync, probeCached };
}
