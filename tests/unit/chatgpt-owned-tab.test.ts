/**
 * 扩展「专属 chatgpt.com 标签页」生命周期测试（fix/chatgpt-owned-tab）。
 *
 * 背景：旧实现 registerPort 接受任何连上来的 deepapi-chatgpt port，于是会劫持用户自己
 * 正在手动操作的 chatgpt.com 标签页（location.assign('/') 把用户导航走、清 composer、
 * 插队到用户对话前面）。修复方向是扩展独占一个标签页，本模块负责它的开/复用/等待就绪。
 *
 * 覆盖：
 *  - ensureOwnedTab：复用 storage 记录的 tab、用户关掉后重建、tab 被跳到别的站点后重建
 *    （防浏览器复用 tabId 劫持用户标签页）、新建走独立窗口且 focused:false、不抢焦点。
 *  - ensureReady：adopt 归属 → 轮询等 relay 连上 → 超时不抛（由 adapter 转 stream_error）。
 */
import { describe, it, expect } from 'vitest';
import { createOwnedChatGPTTab, type OwnedChatGPTTabDeps } from '../../src/background/chatgpt-owned-tab';

interface Harness {
  deps: OwnedChatGPTTabDeps;
  created: Array<{ url: string; focused: boolean }>;
  written: number[];
  adopted: Array<number | null>;
  sleeps: number[];
  logs: string[];
}

/** 虚拟时钟：sleep 只推进时间，不真的等——保证轮询测试秒级完成。 */
function mkHarness(over: Partial<OwnedChatGPTTabDeps> = {}): Harness {
  const created: Array<{ url: string; focused: boolean }> = [];
  const written: number[] = [];
  const adopted: Array<number | null> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let t = 0;
  let nextTabId = 100;
  const deps: OwnedChatGPTTabDeps = {
    readOwnedTabId: async () => null,
    writeOwnedTabId: async (id) => { written.push(id); },
    getTab: async () => null,
    createWindow: async (createData) => { created.push(createData); return nextTabId++; },
    hasBridgeConnection: () => false,
    adoptOwnedTab: (id) => { adopted.push(id); },
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    readyTimeoutMs: 20_000,
    log: (msg) => { logs.push(msg); },
    ...over,
  };
  return { deps, created, written, adopted, sleeps, logs };
}

describe('ensureOwnedTab（复用自己的标签页，不动用户的）', () => {
  it('storage 记录的 tab 还在 chatgpt.com 上 → 直接复用，不新建、不写回', async () => {
    const h = mkHarness({
      readOwnedTabId: async () => 5,
      getTab: async (id) => (id === 5 ? { id: 5, url: 'https://chatgpt.com/c/abc-123' } : null),
    });
    const tabId = await createOwnedChatGPTTab(h.deps).ensureOwnedTab();
    expect(tabId).toBe(5);
    expect(h.created).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it('记录的 tab 已被用户关掉（getTab → null）→ 新开一个并写回 storage', async () => {
    const h = mkHarness({ readOwnedTabId: async () => 5, getTab: async () => null });
    const tabId = await createOwnedChatGPTTab(h.deps).ensureOwnedTab();
    expect(tabId).toBe(100);
    expect(h.written).toEqual([100]);
  });

  it('记录的 tab 已跳到别的站点 → 视为已丢失并重建（防 tabId 被浏览器复用后劫持用户标签页）', async () => {
    const h = mkHarness({
      readOwnedTabId: async () => 5,
      getTab: async () => ({ id: 5, url: 'https://news.example.com/' }),
    });
    const tabId = await createOwnedChatGPTTab(h.deps).ensureOwnedTab();
    expect(tabId).toBe(100);
    expect(h.written).toEqual([100]);
  });

  it('首次使用（storage 无记录）→ 新开独立窗口、focused:false（不抢用户焦点）', async () => {
    const h = mkHarness();
    const tabId = await createOwnedChatGPTTab(h.deps).ensureOwnedTab();
    expect(tabId).toBe(100);
    expect(h.created).toEqual([{ url: 'https://chatgpt.com/', focused: false }]);
  });

  it('创建失败（拿不到 tabId）→ 抛错，交给 adapter 转成可行动错误', async () => {
    const h = mkHarness({ createWindow: async () => null });
    await expect(createOwnedChatGPTTab(h.deps).ensureOwnedTab()).rejects.toThrow(/chatgpt/i);
  });
});

describe('ensureReady（先确保专属 tab 就绪，再让 adapter 判连接）', () => {
  it('把归属 tabId 交给 bridge（adoptOwnedTab），让 bridge 只认自己的 port', async () => {
    const h = mkHarness({ readOwnedTabId: async () => 5, getTab: async () => ({ id: 5, url: 'https://chatgpt.com/' }) });
    await createOwnedChatGPTTab(h.deps).ensureReady();
    expect(h.adopted).toEqual([5]);
  });

  it('relay 已连上 → 不等待（sleep 一次都不调）', async () => {
    const h = mkHarness({
      readOwnedTabId: async () => 5,
      getTab: async () => ({ id: 5, url: 'https://chatgpt.com/' }),
      hasBridgeConnection: () => true,
    });
    await createOwnedChatGPTTab(h.deps).ensureReady();
    expect(h.sleeps).toHaveLength(0);
  });

  it('relay 未连上 → 轮询等待，连上后立刻返回（不空等到超时）', async () => {
    let polls = 0;
    const h = mkHarness({
      readOwnedTabId: async () => 5,
      getTab: async () => ({ id: 5, url: 'https://chatgpt.com/' }),
      hasBridgeConnection: () => { polls++; return polls >= 3; },
      readyTimeoutMs: 20_000,
    });
    await createOwnedChatGPTTab(h.deps).ensureReady();
    expect(h.sleeps.length).toBeGreaterThan(0);
    expect(h.logs).toHaveLength(0);   // 等到了不算异常
  });

  it('relay 一直没连上 → 到点返回（不抛），留日志；由 adapter 决定给用户什么文案', async () => {
    const h = mkHarness({
      readOwnedTabId: async () => 5,
      getTab: async () => ({ id: 5, url: 'https://chatgpt.com/' }),
      readyTimeoutMs: 1_000,
    });
    await createOwnedChatGPTTab(h.deps).ensureReady();
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toMatch(/relay/i);
  });
});
