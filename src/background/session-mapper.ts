import type { Message } from '../shared/api-types';

export interface ThreadEntry {
  providerId: string;       // 2026-09-09：持久化恢复需要重建 `providerId:conversationId` 键
  conversationId: string;
  webSessionId: string;
  parentMessageId: number | string | null;
  mirror: Message[];       // 已确认推进的消息序列（与网页线程内容一致，spec §4.3）
  kind: 'auto' | 'named';
  idleSince: number;
  lastUsedAt: number;
  busy: boolean;
}

export type Decision =
  | { action: 'incremental'; thread: ThreadEntry; tail: Message[] }
  | { action: 'rebuild'; existing: ThreadEntry | null }
  | { action: 'error'; code: 'invalid_request_error'; message: string };

export class SessionMapper {
  private threads = new Map<string, ThreadEntry>();
  private seq = 0;
  // 2026-09-09（fix/thread-persistence）：状态变更回调——sw.ts 挂 chrome.storage 持久化，
  // 重装扩展/刷新页面（MV3 SW 重启）后 threads 从数据层恢复，续聊仍对应 DeepSeek 同一会话。
  onPersist?: (snap: { seq: number; threads: ThreadEntry[] }) => void;
  constructor(
    private deps: { createSession(): Promise<{ webSessionId: string }>; deleteSession(id: string): Promise<void>; now(): number },
    private cfg: { poolSize: number; ttlMs: number },
  ) {}

  private key(providerId: string, conversationId: string) { return `${providerId}:${conversationId}`; }

  decide(providerId: string, messages: Message[], conversationId?: string): Decision {
    if (messages.length === 0) return { action: 'error', code: 'invalid_request_error', message: 'messages is empty' };
    // 全量 messages（含末条）用于匹配：镜像 ⊆ messages 即命中；
    // 未在网页线程上的部分 = messages.slice(mirror.length)（含最新一条 user 消息）。
    if (conversationId) {
      const t = this.threads.get(this.key(providerId, conversationId));
      if (!t) return { action: 'rebuild', existing: null };
      const namedTail = messages.slice(t.mirror.length);
      if (mirrorIsPrefix(t.mirror, messages) && namedTail.length > 0 && (namedTail[0]!.role === 'user' || namedTail[0]!.role === 'tool')) {
        return { action: 'incremental', thread: t, tail: namedTail };
      }
      return { action: 'rebuild', existing: t };
    }
    let best: ThreadEntry | null = null;
    for (const t of this.threads.values()) {
      if (t.kind !== 'auto' || t.busy) continue;
      if (!mirrorIsPrefix(t.mirror, messages)) continue;
      // 多候选：取镜像最长者；等长时取最近未用（LRU）——确定性（spec §4.3）
      if (best === null || t.mirror.length > best.mirror.length || (t.mirror.length === best.mirror.length && t.lastUsedAt < best.lastUsedAt)) best = t;
    }
    if (best) {
      const tail = messages.slice(best.mirror.length);
      if (tail.length === 0) return { action: 'rebuild', existing: best };        // 完整重放（spec §4.3）
      if (tail[0]!.role !== 'user' && tail[0]!.role !== 'tool') return { action: 'rebuild', existing: best }; // 尾部必须以 user 或 tool 开头
      return { action: 'incremental', thread: best, tail };
    }
    return { action: 'rebuild', existing: null };
  }

  register(providerId: string, conversationId: string, webSessionId: string, mirror: Message[]): ThreadEntry {
    const t: ThreadEntry = {
      providerId, conversationId, webSessionId, parentMessageId: null,
      mirror: mirror.map(x => ({ ...x })),
      kind: conversationId.startsWith('auto:') ? 'auto' : 'named',
      idleSince: this.deps.now(), lastUsedAt: this.deps.now(), busy: false,
    };
    if (this.threads.has(this.key(providerId, conversationId))) this.threads.delete(this.key(providerId, conversationId));
    this.threads.set(this.key(providerId, conversationId), t);
    while (this.countAuto(providerId) > this.cfg.poolSize) {
      const victim = [...this.threads.values()].filter(x => x.kind === 'auto').sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) break;
      void this.deps.deleteSession(victim.webSessionId);   // best-effort（spec §4.3 淘汰）
      this.threads.delete(this.key(providerId, victim.conversationId));
    }
    this.persist();
    return t;
  }

  markBusy(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (t) t.busy = true;
  }

  commit(providerId: string, conversationId: string, messages: Message[], webSessionId: string, parentMessageId: number | string | null) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) { this.register(providerId, conversationId, webSessionId, messages); return; }
    t.mirror = messages.map(x => ({ ...x }));
    t.parentMessageId = parentMessageId;
    t.busy = false;
    t.lastUsedAt = this.deps.now();
    t.idleSince = this.deps.now();
    this.persist();
  }

  async fail(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) return;
    this.threads.delete(this.key(providerId, conversationId));
    try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort per spec */ }
    this.persist();
  }

  touch(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (t) { t.lastUsedAt = this.deps.now(); t.idleSince = this.deps.now(); }
  }

  async evictExpired(providerId: string) {
    const now = this.deps.now();
    let changed = false;
    for (const t of [...this.threads.values()]) {
      if (now - t.idleSince > this.cfg.ttlMs) {
        this.threads.delete(this.key(providerId, t.conversationId));
        try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort per spec */ }
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  // 2026-09-09（fix/thread-persistence）：serialize → onPersist（sw.ts 写 chrome.storage.local）。
  // 只在真正变更后通知（register/commit/fail/淘汰），避免每轮 commit 都打空转。
  private persist() {
    this.onPersist?.(this.serialize());
  }

  stats() { return { threads: this.threads.size, busy: [...this.threads.values()].filter(t => t.busy).length }; }

  // 2026-09-09（fix/thread-persistence）：MV3 service worker 被浏览器终止后内存全清——
  // threads Map 丢失 → decide 找不到 thread → rebuild → DeepSeek 新 Conversation（用户实测：
  // 隔 24 分钟续聊必新建会话）。serialize/restore 让 SW 重启后恢复线程（webSessionId/
  // parentMessageId/mirror 都在），续聊回到**同一个** DeepSeek 会话/父链。
  serialize(): { seq: number; threads: ThreadEntry[] } {
    return { seq: this.seq, threads: [...this.threads.values()] };
  }

  restore(snap: { seq: number; threads: ThreadEntry[] }): void {
    this.seq = snap.seq;
    // busy 置 false：SW 重启后进程锁失效（decide 对 auto 线程跳过 busy，不重置会死锁到 TTL）
    this.threads = new Map(snap.threads.map((t) => [this.key(t.providerId, t.conversationId), { ...t, busy: false }]));
  }

  private countAuto(providerId: string) { return [...this.threads.values()].filter(t => t.kind === 'auto').length; }

  nextAutoConversationId() { return `auto:${++this.seq}`; }
}

// 2026-09-09（fix/thread-persistence）：system 不参与上下文连续性判定——system 是调用方注入的
// 指令（spice 每次重构 system prompt，知识库修复即变），mirror[0] 存的是上一轮旧 system，
// 比对含 system 会让任何 prompt 演进（或 SW 重启后 spice 端重新生成）都触发 rebuild 断会话。
// 业务序列（user/assistant/tool）才是「同一会话续聊」的判据。
function mirrorIsPrefix(mirror: Message[], messages: Message[]): boolean {
  const mm = mirror.filter((x) => x.role !== 'system');
  const ms = messages.filter((x) => x.role !== 'system');
  if (mm.length > ms.length) return false;
  for (let i = 0; i < mm.length; i++) if (!sameMsg(mm[i]!, ms[i]!)) return false;
  return true;
}
function sameMsg(a: Message, b: Message): boolean {
  return a.role === b.role && normContent(a.content) === normContent(b.content)
    && (a.tool_call_id ?? null) === (b.tool_call_id ?? null)
    && (a.name ?? null) === (b.name ?? null)
    && JSON.stringify(a.tool_calls ?? null) === JSON.stringify(b.tool_calls ?? null);
}
/** null 与 '' 视为等价：OpenAI 客户端多轮场景下，assistant 带 tool_calls 时 content 通常为 null，
 *  而 deep.api router finalize 存的是 ''（agg.content）。两种表示语义相同。 */
function normContent(c: string | null | undefined): string | null {
  if (c === '' || c === undefined) return null;
  return c;
}
