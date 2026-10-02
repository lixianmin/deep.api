/**
 * ChatGPT provider 的 SW 侧桥接客户端（bridge-client）。
 *
 * 职责（v1 范围，按 brief 收口）：
 *  1. 维护一组 chatgpt.com tab 的 chrome.runtime.Port（每个 tab 一个 ISOLATED relay port）。
 *  2. 暴露 request(opts) → AsyncIterable<ChatGPTBridgeEvent>，把 SW 收到的「要发到 chatgpt 页面的 send 指令」
 *     写到当前活跃 port，等待 MAIN world 流式回包并按 kind 产出事件。
 *  3. 串行：一次只有一个 in-flight request，其它在内部 queue 等待。
 *  4. 超时：默认 120s，命中后产 error 事件 + 自动从 active 退槽（pending 表立即释放）。
 *  5. 断线：port.onDisconnect 触发 → 当前 active request 转入「等待重新接管」窗口（REATTACH_TIMEOUT_MS）；
 *     窗口内没有新 port 接管才产 'chatgpt tab disconnected' 结束（见 REATTACH_TIMEOUT_MS 注释：
 *     页面侧导航交接会主动断 port，那不是故障）；port 从池中移除。
 *
 * 配对策略（brief 与 Ruling 4）：
 *   conversation_id 优先 → 请求 FIFO 次之（**不**靠 requestId 配对）。
 *   实际实现：单 in-flight 时所有回包都进 active 的 buffer（自然 FIFO），
 *   'conversation' 事件被 active.conversationId 内部状态捕获（去重：第二次保存不会改写）。
 *   这两条规则 + 单 in-flight = 所有事件都正确路由。
 *
 * 设计取舍（写下来备查）：
 *   - PortLike 接口（不绑 chrome.runtime.Port）：测试可注入纯 stub，SW 端传 chrome.runtime.Port 即可。
 *   - request() 返回 AsyncIterableIterator（不是 generator function）：可以暴露 return()/throw()，
 *     让 consumer 提前结束（for-await break 走 throw pipe）→ 内部清理 timer + 释放 active。
 *   - 默认 timeout 120s（来自 brief）：单条请求的最长寿命，超时即按错误结束。
 *     短超时（progress 内置）由 adapter 层处理（用 REQUEST_WATCHDOG_MS）；这里只兜底「永远不发 done」。
 */
import type { ChatGPTSendMsg } from '../../../shared/chatgpt-protocol';

/**
 * 「等待重新接管」窗口（ms）：active 请求失去 port 后留给页面重新连上来的时间。
 *
 * 为什么必须有这个窗口：页面侧在 conversationId === null 且当前路径不是 '/'（例如标签页已被上一次
 * 请求带到 /c/<id>）时会 `location.assign('/')`（chatgpt-bridge-main.ts 的 decideSendNavigation），
 * 这是**设计的一部分**——旧文档销毁前已把指令存进 sessionStorage，新文档重注入后自行接着跑
 * （见该文件头「跨导航恢复」）。旧文档被销毁 → content script 的 port 必然断开。所以这里的断开
 * 是**正常交接信号**，不是故障；旧实现把它当致命断线，且 port 已死、error 事件根本发不出去，
 * 表现为「第一次请求成功后，之后每次请求（新线程必触发导航）都毫无响应」。
 *
 * 为什么取 20000：一次交接要走完「导航 → 新文档加载 → content script 注入 → 取回 sessionStorage
 * → 等 composer 水合」，实测 1-4 秒，20s 与 chatgpt-owned-tab 的 readyTimeoutMs 同量级。
 * 为什么不能再大：它必须**显著小于**请求总超时（默认 120s），否则「用户真把专属窗口关了」这类
 * 真故障会被拖到总超时才报错，用户白等两分钟。
 */
export const REATTACH_TIMEOUT_MS = 20_000;

export interface ChatGPTPortLike {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
  onDisconnect(cb: () => void): void;
}

/**
 * send 指令（SW → MAIN world）的类型与判定谓词都在共享协议模块 src/shared/chatgpt-protocol.ts：
 * 本文件是**唯一**生产者（下面的 `const msg: ChatGPTSendMsg`），接收端 chatgpt-bridge-main.ts
 * 用同一个模块的 isChatGPTSendMsg 做判定——两侧绑在一个定义上，形状再漂移编译器会先报错。
 * 2026-10-04（fix/chatgpt-send-envelope-mismatch）：此前本类型只存在于本文件、接收端另写了一套
 * 判断（`__deepApiChatGPT === 'send'`），两侧各自单测全绿而真实链路静默丢包。
 */

/** MAIN world → SW 的流事件（不含已过滤的内部字段）。 */
export type ChatGPTBridgeEvent =
  | { kind: 'stream-start' }
  | { kind: 'frame'; event: string | null; data: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/** raw 形态：MAIN world 实际 postMessage 的对象（带 requestId 等冗余字段）。 */
export interface ChatGPTIncomingMsg {
  __deepApiChatGPT: true;
  kind: string;
  requestId?: string;
  event?: string | null;
  data?: string;
  conversationId?: string;
  message?: string;
  [k: string]: unknown;
}

export interface BridgeRequestOpts {
  requestId: string;
  text: string;
  conversationId: string | null;
  /** 单条请求超时（ms）。≤0 视为参数错误。不传走 deps.defaultTimeoutMs（默认 120_000）。 */
  timeoutMs?: number;
}

export interface BridgeClientDeps {
  now(): number;
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  opts: BridgeRequestOpts;
  /** 当前活跃时填入；queue 中暂未填。 */
  port: ChatGPTPortLike | null;
  /** 收到的 event 缓存（consumer drain 用）。 */
  buffer: ChatGPTBridgeEvent[];
  /** 流是否已结束（done=true 后 buffer drain 完即终止迭代）。 */
  done: boolean;
  /** 'error' 事件的 message（done 时填，buffer 已含 error 事件）。 */
  error: string | null;
  /** 唤醒 consumer next() 的回调（buffer 空且未 done 时挂起）。 */
  wake: (() => void) | null;
  /** 超时定时器句柄。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 「等待重新接管」定时器句柄（仅 port 断开后存在；见 REATTACH_TIMEOUT_MS）。 */
  reattachTimer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

export interface BridgeClient {
  /** 是否有「扩展自己那个」chatgpt tab 处于连接态（用户自己开的 tab 不算）。 */
  hasConnection(): boolean;
  /**
   * 声明扩展专属的 tabId（chatgpt-owned-tab 模块负责开/复用它）。设为 null 表示尚未确定归属。
   * 只有 tabId === ownedTabId 的 port 会被使用——用户自己开着的 chatgpt.com 标签页一律无视。
   */
  setOwnedTab(tabId: number | null): void;
  /** 注册一个新 port（由 SW 的 onConnect 处理调用）。tabId = 发起连接的标签页。 */
  registerPort(port: ChatGPTPortLike, tabId?: number): void;
  /** 主动移除 port（一般不需要——onDisconnect 自动调用；但保留供测试/强制下线）。 */
  removePort(port: ChatGPTPortLike): void;
  /**
   * 发起一个 bridge 请求。返回 AsyncIterableIterator：
   *   - 无 port → 同步抛 'no chatgpt tab connected'
   *   - 参数错（timeoutMs≤0）→ 同步抛
   *   - 正常路径：post 'send' 到当前 port → 等回包
   *   - 迭代器 break/return 时清理 timer + 释放队列
   */
  request(opts: BridgeRequestOpts): AsyncIterableIterator<ChatGPTBridgeEvent>;
}

export function createBridgeClient(deps: BridgeClientDeps): BridgeClient {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 120_000;
  /** 已注册 port 集合（value = alive 状态 + 归属 tabId）。 */
  const ports = new Map<ChatGPTPortLike, { alive: boolean; tabId: number | undefined }>();
  /** 等待中的请求（不含正在跑的）。 */
  const queue: PendingRequest[] = [];
  /** 当前活跃请求（queue head 已被 pump 后填进来）。 */
  let active: PendingRequest | null = null;
  /** 扩展专属标签页 id（null = 尚未认领）。 */
  let ownedTabId: number | null = null;

  /**
   * 这个 port 是不是「扩展自己那个标签页」的。
   *
   * 2026-10-04（fix/chatgpt-owned-tab）：为什么只认自己的 tab——旧实现接受任何连上来的
   * deepapi-chatgpt port，于是扩展会劫持用户自己正在手动操作的 chatgpt.com 标签页：
   * conversationId 为空时 location.assign('/') 把用户正在看的会话导航走、清空并占用用户的
   * composer 输入框、把扩展的请求插队到用户自己的对话前面。所以不属于 ownedTabId 的 port
   * 一律**直接无视**（不报错、不 disconnect、不清 storage）——它在用户那边完全不受影响。
   * ownedTabId 尚未确定（SW 刚重启、ensureReady 还没跑）时，带 tabId 的 port 也按「不是自己的」
   * 处理：宁可暂无连接等 ensureReady 认领，也不误用用户标签页。
   */
  function isOwned(entry: { alive: boolean; tabId: number | undefined }): boolean {
    if (!entry.alive) return false;
    if (ownedTabId === null) return entry.tabId === undefined;
    return entry.tabId === ownedTabId;
  }

  function hasConnection(): boolean {
    for (const v of ports.values()) if (isOwned(v)) return true;
    return false;
  }

  function pickAlivePort(): ChatGPTPortLike | null {
    for (const [p, v] of ports.entries()) if (isOwned(v)) return p;
    return null;
  }

  /** 清掉一个 pending 自己的全部定时器（总超时 + 等待接管）。收口点，避免漏清导致泄漏 / 误报。 */
  function clearTimers(p: PendingRequest): void {
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p.reattachTimer) { clearTimeout(p.reattachTimer); p.reattachTimer = null; }
  }

  /** 把 active 推到下一阶段（清掉 timer、置 null）；若 queue 非空则启动下一个。 */
  function releaseActive(): void {
    if (active) clearTimers(active);
    active = null;
    pumpQueue();
  }

  /**
   * active 请求与它的 port 失去联系 → 转入「等待重新接管」，**不**判死。
   *
   * 2026-10-04（fix/chatgpt-nav-port-handoff）：旧实现在这里立刻产 'chatgpt tab disconnected'
   * 并收尾，而 port 断开恰恰是页面侧**故意**做的导航交接（见 REATTACH_TIMEOUT_MS 注释）。
   * 现在：置空 port（不再往死 port 写）、保留总超时 timer（「永不回包」的兜底不撤）、
   * 另起 reattachTimer；窗口内有新 port 注册就由 registerPort 重新接管。
   * 注意**不清** buffer / 不 releaseActive：请求还在飞，只是暂时没有传输通道。
   */
  function detachActivePort(): void {
    if (active === null || active.port === null) return;   // 没有在飞 / 已经处于等待接管态
    active.port = null;
    if (active.reattachTimer) clearTimeout(active.reattachTimer);
    active.reattachTimer = setTimeout(() => {
      if (active === null || active.done) return;
      active.reattachTimer = null;
      if (active.port !== null) return;   // 已被新 port 接管（registerPort 会清掉本 timer，这里再兜一层）
      // 窗口内没人接管 → 真故障（专属窗口被关 / 页面一直不恢复）。文案与释放路径保持与旧行为一致。
      active.done = true;
      active.error = 'chatgpt tab disconnected';
      active.buffer.push({ kind: 'error', message: active.error });
      if (active.wake) { const w = active.wake; active.wake = null; w(); }
      queueMicrotask(() => {
        if (active !== null && active.done && active.buffer.length === 0) {
          active = null;
          pumpQueue();
        }
      });
    }, REATTACH_TIMEOUT_MS);
  }

  function pumpQueue(): void {
    if (active !== null) return;   // 已有在飞
    while (queue.length > 0) {
      const next = queue.shift()!;
      const port = pickAlivePort();
      if (!port) {
        // 没有 port 了 → 立刻以错误结束此 pending
        next.done = true;
        next.error = 'no chatgpt tab connected';
        next.buffer.push({ kind: 'error', message: next.error });
        if (next.wake) { const w = next.wake; next.wake = null; w(); }
        continue;   // 试下一个（理论上 queue 内多个都是这原因）
      }
      next.port = port;
      active = next;
      // 装超时定时器
      const timeoutMs = next.opts.timeoutMs ?? defaultTimeoutMs;
      next.timer = setTimeout(() => {
        if (active !== next) return;
        next.done = true;
        next.error = `bridge request timeout after ${timeoutMs}ms`;
        next.buffer.push({ kind: 'error', message: next.error });
        if (next.wake) { const w = next.wake; next.wake = null; w(); }
        releaseActive();
      }, timeoutMs);
      // 发 'send' 到 port
      const msg: ChatGPTSendMsg = {
        __deepApiChatGPT: true,
        kind: 'send',
        requestId: next.opts.requestId,
        text: next.opts.text,
        conversationId: next.opts.conversationId,
      };
      try {
        port.postMessage(msg);
      } catch {
        // postMessage 抛错（port 已死但 onDisconnect 还没触发）—— 与 onDisconnect 同一条路径：
        // 也可能是交接（旧文档刚销毁），不判死，等新 port 接管。
        detachActivePort();
      }
      return;
    }
  }

  function dispatchIncoming(msg: ChatGPTIncomingMsg): void {
    if (active === null) return;   // 没人在飞：丢弃（理论上 active 必定非 null，因为 send 已发；但保险起见）
    // 2026-10-01（fix/bridge-stale-frames）：按 requestId 过滤入站消息。请求超时释放后，背后的
    // tap 仍在 reader 上读到后续 frames/done，若混入后续 r2 就会把当前 request 的回复截断并当作正常结束。
    // 规则：缺 requestId 字段时跳过过滤（兼容旧 stub / 老版本 MAIN world）；带 requestId 但
    // 不匹配 active.opts.requestId → 丢。
    if (typeof msg.requestId === 'string' && msg.requestId !== active.opts.requestId) return;
    const kind = msg.kind;
    if (kind === 'conversation' && typeof msg.conversationId === 'string') {
      // 2026-10-01（fix/dead-field）：旧实现存 active.conversationId 字段仅用于幂等判断，
      // 但该字段无任何后续读取路径——是死字段。现不存任何内部状态，重复 'conversation'
      // 事件原样产出去重由上层（consumer/adapter）决定。
      active.buffer.push({ kind: 'conversation', conversationId: msg.conversationId });
    } else if (kind === 'frame') {
      active.buffer.push({ kind: 'frame', event: typeof msg.event === 'string' ? msg.event : null, data: typeof msg.data === 'string' ? msg.data : '' });
    } else if (kind === 'stream-start') {
      active.buffer.push({ kind: 'stream-start' });
    } else if (kind === 'done') {
      active.done = true;
      active.buffer.push({ kind: 'done' });
      // 注意：这里不要立即 releaseActive，让 consumer 先 drain 完 done 事件再走下一次 pump
      // consumer 在 done 事件之后会 break for-await → return() 被调用 → releaseActive
      // 但 consumer 可能因异常不 return，所以加一个 microtask 兜底
      queueMicrotask(() => {
        if (active === null) return;
        // consumer 已 drain：buffer 应已被消费为空 + done=true；这里仅在 active 仍引用同一 req 时清掉
        if (active!.done && active!.buffer.length === 0) releaseActive();
      });
    } else if (kind === 'error') {
      active.done = true;
      active.error = typeof msg.message === 'string' ? msg.message : 'unknown bridge error';
      active.buffer.push({ kind: 'error', message: active.error });
      queueMicrotask(() => {
        if (active === null) return;
        if (active!.done && active!.buffer.length === 0) releaseActive();
      });
    }
    // 未知 kind 忽略（防外部脚本注入——前面对 __deepApiChatGPT === true 已过滤一层）
    if (active.wake) {
      const w = active.wake;
      active.wake = null;
      w();
    }
  }

  function handlePortMessage(port: ChatGPTPortLike, raw: unknown): void {
    // 双层过滤：①必须是 __deepApiChatGPT === true（防外部注入）；② shape 必须合法
    if (typeof raw !== 'object' || raw === null) return;
    const m = raw as { __deepApiChatGPT?: unknown };
    if (m.__deepApiChatGPT !== true) return;
    const msg = raw as ChatGPTIncomingMsg;
    if (typeof msg.kind !== 'string') return;
    dispatchIncoming(msg);
  }

  function setOwnedTab(tabId: number | null): void {
    ownedTabId = tabId;
  }

  function registerPort(port: ChatGPTPortLike, tabId?: number): void {
    ports.set(port, { alive: true, tabId });
    port.onMessage((m) => { handlePortMessage(port, m); });
    port.onDisconnect(() => {
      const v = ports.get(port);
      if (v) v.alive = false;
      ports.delete(port);
      // 断的是当前 active 用的 port → 转入等待接管（不判死；没有在飞请求时行为不变，只是删 port）
      if (active !== null && active.port === port) detachActivePort();
    });
    // 新 port 注册时，若有一个正停在「等待重新接管」的 active 请求 → 交给它接管。
    // 这里**不重发** send：页面侧已用 sessionStorage 的 pendingSend 接住同一个请求，新文档的
    // content script 会继续推进并回帧；帧按 requestId 匹配路由（dispatchIncoming 不看 port），
    // 所以新 port 的帧本来就能流进同一个 active 请求。
    if (active !== null && active.port === null && active.reattachTimer !== null) {
      active.port = port;
      clearTimeout(active.reattachTimer);
      active.reattachTimer = null;
    }
    // 若当前有等在 queue 里的请求，立即尝试 pump
    if (active === null) pumpQueue();
  }

  function removePort(port: ChatGPTPortLike): void {
    ports.delete(port);
  }

  function makeIterator(p: PendingRequest): AsyncIterableIterator<ChatGPTBridgeEvent> {
    const it: AsyncIterableIterator<ChatGPTBridgeEvent> = {
      [Symbol.asyncIterator]() { return it; },
      async next(): Promise<IteratorResult<ChatGPTBridgeEvent>> {
        while (true) {
          if (p.buffer.length > 0) {
            const ev = p.buffer.shift()!;
            return { value: ev, done: false };
          }
          if (p.done) {
            return { value: undefined, done: true };
          }
          // 挂起等唤醒
          await new Promise<void>((r) => { p.wake = r; });
          if (p.cancelled) {
            return { value: undefined, done: true };
          }
        }
      },
      async return(): Promise<IteratorResult<ChatGPTBridgeEvent>> {
        p.cancelled = true;
        clearTimers(p);   // cancel 也要连 reattachTimer 一起清：已取消的请求不得被接管逻辑复活
        if (p.wake) { const w = p.wake; p.wake = null; w(); }
        // 如果是 active 的被取消 → 释放 + pump 下一个
        if (active === p) {
          active = null;
          pumpQueue();
        }
        return { value: undefined, done: true };
      },
      async throw(e: unknown): Promise<IteratorResult<ChatGPTBridgeEvent>> {
        p.cancelled = true;
        clearTimers(p);   // 同 return()：清理总超时 + 等待接管定时器
        if (p.wake) { const w = p.wake; p.wake = null; w(); }
        if (active === p) {
          active = null;
          pumpQueue();
        }
        throw e;
      },
    };
    return it;
  }

  function request(opts: BridgeRequestOpts): AsyncIterableIterator<ChatGPTBridgeEvent> {
    // 参数校验
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
      throw new Error('bridge-client: timeoutMs must be > 0');
    }
    if (!hasConnection()) {
      throw new Error('bridge-client: no chatgpt tab connected (the extension-owned chatgpt.com tab is not connected)');
    }
    const p: PendingRequest = {
      opts,
      port: null,
      buffer: [],
      done: false,
      error: null,
      wake: null,
      timer: null,
      reattachTimer: null,
      cancelled: false,
    };
    queue.push(p);
    pumpQueue();
    return makeIterator(p);
  }

  return { hasConnection, setOwnedTab, registerPort, removePort, request };
}