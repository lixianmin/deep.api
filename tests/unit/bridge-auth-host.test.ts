// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isAuthSyncHost } from '../../src/content/bridge-main';

// 2026-09-15（fix/auth-flip-flop）失败测试：token 推送来源必须只认 chat.deepseek.com。
// 曾用 endsWith('.deepseek.com') 通配——其他子域名（www / platform 等）localStorage 里残留的
// 过期 userToken 也会被每 5s 推给 SW，与 chat 站的好 token 互相顶替（用户实测的定期 40003 故障根源）。

describe('isAuthSyncHost（token 推送来源白名单）', () => {
  it('chat.deepseek.com 是唯一合法来源', () => {
    expect(isAuthSyncHost('chat.deepseek.com')).toBe(true);
  });

  it('其他子域名一律不推（残留过期 token 的来源）', () => {
    expect(isAuthSyncHost('www.deepseek.com')).toBe(false);
    expect(isAuthSyncHost('platform.deepseek.com')).toBe(false);
    expect(isAuthSyncHost('api.deepseek.com')).toBe(false);
  });

  it('仿冒/无关域名不推', () => {
    expect(isAuthSyncHost('chat.deepseek.com.evil.io')).toBe(false);
    expect(isAuthSyncHost('deepseek.com')).toBe(false);
    expect(isAuthSyncHost('example.com')).toBe(false);
  });
});
