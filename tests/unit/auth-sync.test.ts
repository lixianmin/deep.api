import { describe, it, expect } from 'vitest';
import { createAuthSync, BAD_TTL_MS, GOOD_TTL_MS, type AuthStatus } from '../../src/background/auth-sync';

// 2026-09-15（fix/auth-flip-flop）失败测试：复现用户实测的 token 交替顶替故障。
// 现场：两个 *.deepseek.com 来源每 5s 各推一个 token，一个永久 expired（F 开头）、一个 logged_in（T 开头），
// SW 缓存每 ~5s 翻转一次 → 翻转到的半个周期里所有 chat 请求 401/40003（"经常定期失败，登录失败"）。
// 修法：auth.sync 采纳策略带守卫——坏名单（近期探测 expired 的 token 直接拒绝）+
// 好窗口（缓存 token 近期探测 logged_in 时，incoming 必须先探测，expired 不得顶替）。

const LOGGED_IN: AuthStatus = { state: 'logged_in' };
const EXPIRED: AuthStatus = { state: 'expired', message: '登录失效（业务 code=40003）' };

function harness(initialToken: string | null = null, now: () => number = () => 1_000_000) {
  let cached = initialToken;
  const probes: (string | null)[] = [];
  const sets: (string | null)[] = [];
  const deps = {
    loadCachedToken: async () => cached,
    setCachedToken: async (t: string | null) => { cached = t; sets.push(t); },
    probeToken: async (t: string | null) => { probes.push(t); return t?.startsWith('tok-good') ? LOGGED_IN : EXPIRED; },
  };
  const authSync = createAuthSync(deps, now);
  return { authSync, probes, sets, get cached() { return cached; } };
}

describe('auth-sync 采纳策略（fix/auth-flip-flop）', () => {
  it('坏 token 不得顶掉近期验证过的好 token（复现交替故障的主场景）', async () => {
    const h = harness();
    // chat.deepseek.com 页面推送好 token → 采纳
    const r1 = await h.authSync.handleSync('tok-good');
    expect(r1.action).toBe('accepted');
    expect(h.cached).toBe('tok-good');
    // 另一个来源（坏 localStorage）推送过期 token → 必须拒绝，缓存不动
    const r2 = await h.authSync.handleSync('tok-expired');
    expect(r2.action).toBe('rejected-expired-vs-good');
    expect(h.cached).toBe('tok-good');
    // 好 token 重复推送 → no-op（不探测）
    const r3 = await h.authSync.handleSync('tok-good');
    expect(r3.action).toBe('ignored-unchanged');
    expect(h.cached).toBe('tok-good');
  });

  it('坏名单：同一过期 token 反复推送只探测一次，之后窗口内直接拒绝', async () => {
    const h = harness();
    await h.authSync.handleSync('tok-good');
    const probesAfterGood = h.probes.length;
    await h.authSync.handleSync('tok-expired');           // 首次：探测一次，拒绝
    expect(h.cached).toBe('tok-good');
    await h.authSync.handleSync('tok-expired');           // 再次：坏名单命中，不再探测
    await h.authSync.handleSync('tok-expired');
    expect(h.cached).toBe('tok-good');
    expect(h.probes.length).toBe(probesAfterGood + 1);
  });

  it('真实重登：incoming 探测 logged_in 时照常采纳（守卫不挡合法换 token）', async () => {
    const h = harness();
    await h.authSync.handleSync('tok-good');
    const r = await h.authSync.handleSync('tok-good-2');
    expect(r.action).toBe('accepted');
    expect(h.cached).toBe('tok-good-2');
    // 只探测 incoming 一次（采纳后不重复探测缓存——status 已知）
    expect(h.probes.filter((t) => t === 'tok-good-2').length).toBe(1);
  });

  it('无好窗口时（SW 冷启动、缓存为空）过期 token 照实采纳——页面真相就是真相', async () => {
    const h = harness();
    const r = await h.authSync.handleSync('tok-expired');
    expect(r.action).toBe('accepted');
    expect(h.cached).toBe('tok-expired');
    if (r.action === 'accepted') expect(r.status.state).toBe('expired');
  });

  it('null token 不清缓存（保留既有防御，不回归）', async () => {
    const h = harness('tok-good');
    const r = await h.authSync.handleSync(null);
    expect(r.action).toBe('ignored-null');
    expect(h.cached).toBe('tok-good');
  });

  it('probeCached 探测的是当前缓存 token，并把结果记入守卫状态', async () => {
    const h = harness('tok-good');
    const st = await h.authSync.probeCached();
    expect(st.state).toBe('logged_in');
    expect(h.probes).toEqual(['tok-good']);
    // 之后坏 token 推送被好窗口拦截
    const r = await h.authSync.handleSync('tok-expired');
    expect(r.action).toBe('rejected-expired-vs-good');
  });

  it('坏名单窗口过期后重新探测（token 可能复苏，不永久拉黑）', async () => {
    let t = 0;
    const h = harness(undefined, () => t);
    await h.authSync.handleSync('tok-good');                    // good 窗口起点
    await h.authSync.handleSync('tok-expired');                 // 进坏名单 @t=0
    const probeCount = h.probes.length;
    t += BAD_TTL_MS + 1;
    await h.authSync.handleSync('tok-expired');                 // 窗口已过 → 重新探测
    expect(h.probes.length).toBe(probeCount + 1);
  });

  it('好窗口过期后不再拦截顶替（信任有期限，回退为照实采纳）', async () => {
    let t = 0;
    const h = harness(undefined, () => t);
    await h.authSync.handleSync('tok-good');                    // good @t=0
    t += GOOD_TTL_MS + 1;
    const r = await h.authSync.handleSync('tok-expired');
    expect(r.action).toBe('accepted');
    expect(h.cached).toBe('tok-expired');
  });
});
