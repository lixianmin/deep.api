/**
 * ChatGPT provider 的 SW 侧桥接客户端（bridge-client）。
 *
 * 职责（v1 范围，按 brief 收口）：
 *  1. 维护一组 chatgpt.com tab 的 chrome.runtime.Port（每个 tab 一个 ISOLATED relay port）。
 *  2. 暴露 request(opts) → AsyncIterable<ChatGPTBridgeEvent>，把 SW 收到的「要发到 chatgpt 页面的 send 指令」
 *     写到当前活跃 port，等待 MAIN world 流式回包并按 kind 产出事件。
 *  3. 串行：一次只有一个 in-flight request，其它在内部 queue 等待。
 *  4. 超时：默认 120s，命中后产 error 事件 + 自动从 active 退槽（pending 表立即释放）。
 *  5. 断线：port.onDisconnect 触发 → 当前 active request 产 error 结束；port 从池中移除。
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
export interface ChatGPTPortLike {
  postMessage(m: unknown): void;
  onMessage(cb: (m: unknown) => void): void;
  onDisconnect(cb: () => void): void;
}

/** SW → MAIN world 的 send 指令。 */
export interface ChatGPTSendMsg {
  __deepApiChatGPT: true;
  kind: 'send';
  requestId: string;
  text: string;
  conversationId: string | null;
}

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
  /** 首次 'conversation' 事件记录的 conversationId（用于上层回填 session.webSessionId）。 */
  conversationId: string | null;
  /** 流是否已结束（done=true 后 buffer drain 完即终止迭代）。 */
  done: boolean;
  /** 'error' 事件的 message（done 时填，buffer 已含 error 事件）。 */
  error: string | null;
  /** 唤醒 consumer next() 的回调（buffer 空且未 done 时挂起）。 */
  wake: (() => void) | null;
  /** 超时定时器句柄。 */
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

export interface BridgeClient {
  /** 是否有任意 chatgpt tab 处于连接态。 */
  hasConnection(): boolean;
  /** 注册一个新 port（由 SW 的 onConnect 处理调用）。 */
  registerPort(port: ChatGPTPortLike): void;
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
  /** 已注册 port 集合（value = alive 状态）。 */
  const ports = new Map<ChatGPTPortLike, { alive: boolean }>();
  /** 等待中的请求（不含正在跑的）。 */
  const queue: PendingRequest[] = [];
  /** 当前活跃请求（queue head 已被 pump 后填进来）。 */
  let active: PendingRequest | null = null;

  function hasConnection(): boolean {
    for (const v of ports.values()) if (v.alive) return true;
    return false;
  }

  function pickAlivePort(): ChatGPTPortLike | null {
    for (const [p, v] of ports.entries()) if (v.alive) return p;
    return null;
  }

  /** 把 active 推到下一阶段（清掉 timer、置 null）；若 queue 非空则启动下一个。 */
  function releaseActive(): void {
    if (active && active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    active = null;
    pumpQueue();
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
        // postMessage 抛错（port 已死但 onDisconnect 还没触发）—— 走断线路径
        next.done = true;
        next.error = 'chatgpt tab disconnected';
        next.buffer.push({ kind: 'error', message: next.error });
        if (next.wake) { const w = next.wake; next.wake = null; w(); }
        releaseActive();
      }
      return;
    }
  }

  function dispatchIncoming(msg: ChatGPTIncomingMsg): void {
    if (active === null) return;   // 没人在飞：丢弃（理论上 active 必定非 null，因为 send 已发；但保险起见）
    const kind = msg.kind;
    if (kind === 'conversation' && typeof msg.conversationId === 'string') {
      // 幂等：重复 'conversation' 事件不覆盖已记录的 conversationId（Ruling 4 + Task 3 实现者自报）
      if (active.conversationId === null) active.conversationId = msg.conversationId;
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

  function registerPort(port: ChatGPTPortLike): void {
    ports.set(port, { alive: true });
    port.onMessage((m) => { handlePortMessage(port, m); });
    port.onDisconnect(() => {
      const v = ports.get(port);
      if (v) v.alive = false;
      ports.delete(port);
      // 如果断的是当前 active 用的 port → 立刻产 error
      if (active !== null && active.port === port) {
        active.done = true;
        active.error = 'chatgpt tab disconnected';
        active.buffer.push({ kind: 'error', message: active.error });
        if (active.timer) { clearTimeout(active.timer); active.timer = null; }
        if (active.wake) { const w = active.wake; active.wake = null; w(); }
        queueMicrotask(() => {
          if (active !== null && active.done && active.buffer.length === 0) {
            active = null;
            pumpQueue();
          }
        });
      }
    });
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
        if (p.timer) { clearTimeout(p.timer); p.timer = null; }
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
        if (p.timer) { clearTimeout(p.timer); p.timer = null; }
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
      throw new Error('bridge-client: no chatgpt tab connected (open https://chatgpt.com in a tab)');
    }
    const p: PendingRequest = {
      opts,
      port: null,
      buffer: [],
      conversationId: null,
      done: false,
      error: null,
      wake: null,
      timer: null,
      cancelled: false,
    };
    queue.push(p);
    pumpQueue();
    return makeIterator(p);
  }

  return { hasConnection, registerPort, removePort, request };
}