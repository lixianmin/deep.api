// src/background/chatgpt-owned-tab.ts —— 扩展「专属 chatgpt.com 标签页」的生命周期（fix/chatgpt-owned-tab）。
//
// 问题：ChatGPT provider 走网页桥接。旧实现要求用户自己打开一个 chatgpt.com 标签页并保持它开着，
// 而且接受任何连上来的 deepapi-chatgpt port —— 等于劫持用户自己的标签页：conversationId 为空时
// location.assign('/') 把用户正在看的会话导航走、清空并占用用户的 composer、扩展请求插队到用户
// 自己的对话前面。用户在那个标签页里手动操作时，这条链路会直接捣乱。
//
// 修法：扩展自己开一个 chatgpt.com 标签页，并只驱动它。
//   - 放**独立窗口**、focused:false：不混进用户的标签条、视觉上就属于扩展，也不抢用户焦点。
//   - tabId 落 storage：SW（MV3）随时被回收，重启后还能认出「哪个 tab 是自己的」。
//   - 用户把它关了 / 跳到别的站点 / 浏览器重启后 tabId 被复用 → 一律当作已丢失，重开一个，
//     绝不认领别人的 tab。
//   - 用户自己开着的 chatgpt.com 标签页永远不会被认领（bridge-client 侧只认 ownedTabId）。

export interface OwnedTabInfo {
  id?: number;
  url?: string;
}

export interface OwnedChatGPTTabDeps {
  /** 读 storage 里记录的专属 tabId；没有记录返回 null。 */
  readOwnedTabId(): Promise<number | null>;
  /** 把 tabId 写回 storage。 */
  writeOwnedTabId(tabId: number): Promise<void>;
  /** chrome.tabs.get：tab 已不存在（用户关掉了）时返回 null。 */
  getTab(tabId: number): Promise<OwnedTabInfo | null>;
  /** chrome.windows.create：返回新建窗口里那个 tab 的 id；拿不到返回 null。 */
  createWindow(createData: { url: string; focused: boolean }): Promise<number | null>;
  /** bridge.hasConnection()：专属 tab 的 relay 是否已连上。 */
  hasBridgeConnection(): boolean;
  /** bridge.setOwnedTab()：把归属 tabId 告诉 bridge。 */
  adoptOwnedTab(tabId: number | null): void;
  /** chrome.tabs.reload：重载专属 tab，让 relay / bridge-main 作为 manifest content script 重新注入。
   *  best-effort：tab 恰好被用户关掉时会 reject，调用方自行吞掉（见 sw.ts）。 */
  reloadTab(tabId: number): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 等 relay 连上的上限（ms）。默认 20s —— 不得 ≥30s：MV3 SW 空闲 30s 就可能被回收，
   *  而这期间我们正在被 router 的队列（60s 超时）等着。 */
  readyTimeoutMs?: number;
  log?(msg: string): void;
}

export interface OwnedTabRef {
  tabId: number;
  /** true = 本次新建；false = 复用 storage 里记录的那个标签页。
   *  ensureReady 的自愈策略依赖它：新标签页还在加载，重载它纯属白等。 */
  created: boolean;
}

export const CHATGPT_URL = 'https://chatgpt.com/';

/** 轮询间隔：页面加载 + content script 注入通常几秒，250ms 足够灵敏又不至于空转。 */
const POLL_MS = 250;

/** 复用「已存在」的专属标签页时，等 relay 连上的宽限（ms）。
 *  来由：SW 被 MV3 回收后重启时，「标签页在、port 一时不在」是正常现象——健康的 relay 在
 *  onDisconnect 后会按退避重连（chatgpt-bridge-relay.ts BASE_RETRY_MS = 1000，之后 2s、4s…），
 *  通常 ~1s 内就自愈。3s 够容忍一次退避重连，又不至于让真正瘫痪的 relay
 *  （扩展重载/更新后旧上下文已销毁、进入终态停机，永不重连）白等满 20s 才走自愈。
 *  不要把它调大到接近 readyTimeoutMs：那等于放弃了「先快速探活、再决定是否重载」的意义。 */
const STALE_GRACE_MS = 3_000;

function isChatGPTTab(tab: OwnedTabInfo | null): boolean {
  return tab?.id !== undefined && typeof tab.url === 'string' && tab.url.startsWith(CHATGPT_URL);
}

export function createOwnedChatGPTTab(deps: OwnedChatGPTTabDeps): {
  ensureOwnedTab(): Promise<OwnedTabRef>;
  ensureReady(): Promise<void>;
} {
  /** 确保「扩展自己的」chatgpt.com 标签页存在，返回它的 tabId 以及「是否本次新建」。 */
  async function ensureOwnedTab(): Promise<OwnedTabRef> {
    const recorded = await deps.readOwnedTabId();
    if (recorded !== null) {
      let tab: OwnedTabInfo | null = null;
      try {
        tab = await deps.getTab(recorded);
      } catch {
        tab = null;   // chrome.tabs.get 对已关闭的 tab 会 reject
      }
      if (isChatGPTTab(tab)) return { tabId: recorded, created: false };
      // 记录失效有三种可能：用户关掉了 / 用户把它导航去了别的站点 / 浏览器重启后 tabId 被
      // 复用给了别的标签页。第三种最危险——若不校验 url 就会开始驱动用户的标签页，故一律重建。
      deps.log?.(`[deep.api sw] owned chatgpt tab ${recorded} is gone (user closed or navigated it) — recreating`);
    }
    const created = await deps.createWindow({ url: CHATGPT_URL, focused: false });
    if (created === null) throw new Error('failed to open the extension-owned chatgpt.com tab');
    await deps.writeOwnedTabId(created);
    deps.log?.(`[deep.api sw] created owned chatgpt tab ${created}`);
    return { tabId: created, created: true };
  }

  /** 轮询等 relay 连上，返回是否在 timeoutMs 内连上。 */
  async function waitForConnection(timeoutMs: number): Promise<boolean> {
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      if (deps.hasBridgeConnection()) return true;
    }
    return false;
  }

  /**
   * 请求前的准备：确保专属 tab 存在 + 认领归属 + 等它的 relay 连上。
   * 超时**不抛**——连不上时由 adapter 结合 hasConnection() 产出可行动的 stream_error 文案。
   *
   * 2026-10-05（chore/bump-0-2-18-heal-stale-tab）：复用的标签页要做「探活 → 重载」自愈。
   * 只校验「tab 还在 + url 还是 chatgpt.com」是不够的：扩展每次重载/更新都会让旧 relay 的
   * 上下文被销毁并终态停机（chatgpt-bridge-relay.ts 打 "extension context invalidated …
   * retry stopped"，永不重连），于是那个标签页永久瘫痪——SW 认领它后只能等满 20s 报错，
   * 或捡到一个刚断的 port。重载该 tab 会重新注入 relay（manifest content script），是唯一自愈手段。
   */
  async function ensureReady(): Promise<void> {
    const { tabId, created } = await ensureOwnedTab();
    deps.adoptOwnedTab(tabId);
    if (deps.hasBridgeConnection()) return;   // 已连上（SW 重启后 relay 自动重连）
    const timeoutMs = deps.readyTimeoutMs ?? 20_000;
    if (created) {
      // 新标签页要真跑一次加载 + 注入，给足 readyTimeoutMs。超时也不重载：全新页面都连不上，
      // 原因通常在别处（网络、未登录、被墙），再重载一遍只是白等一轮。
      if (await waitForConnection(timeoutMs)) return;
      deps.log?.(`[deep.api sw] owned chatgpt tab ${tabId} relay did not connect within ${timeoutMs}ms`);
      return;
    }
    // 复用的标签页：先给一次短宽限探活（健康 relay 掉线后会自己重连，见 STALE_GRACE_MS）。
    if (await waitForConnection(STALE_GRACE_MS)) return;
    // 宽限内没连上 → 认定这个 relay 已瘫死（扩展重载后的终态停机），重载标签页重新注入。
    await deps.reloadTab(tabId);
    if (await waitForConnection(timeoutMs)) return;
    deps.log?.(`[deep.api sw] owned chatgpt tab ${tabId} relay did not connect within ${timeoutMs}ms after reload`);
  }

  return { ensureOwnedTab, ensureReady };
}
