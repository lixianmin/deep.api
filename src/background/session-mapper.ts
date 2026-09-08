import type { Message } from '../shared/api-types';

export interface ThreadEntry {
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
      if (mirrorIsPrefix(t.mirror, messages) && namedTail.length > 0 && namedTail[0]!.role === 'user') {
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
      if (tail[0]!.role !== 'user') return { action: 'rebuild', existing: best }; // 尾部必须以 user 开头
      return { action: 'incremental', thread: best, tail };
    }
    return { action: 'rebuild', existing: null };
  }

  register(providerId: string, conversationId: string, webSessionId: string, mirror: Message[]): ThreadEntry {
    const t: ThreadEntry = {
      conversationId, webSessionId, parentMessageId: null,
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
  }

  async fail(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) return;
    this.threads.delete(this.key(providerId, conversationId));
    try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort per spec */ }
  }

  touch(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (t) { t.lastUsedAt = this.deps.now(); t.idleSince = this.deps.now(); }
  }

  async evictExpired(providerId: string) {
    const now = this.deps.now();
    for (const t of [...this.threads.values()]) {
      if (now - t.idleSince > this.cfg.ttlMs) {
        this.threads.delete(this.key(providerId, t.conversationId));
        try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort per spec */ }
      }
    }
  }

  stats() { return { threads: this.threads.size, busy: [...this.threads.values()].filter(t => t.busy).length }; }

  private countAuto(providerId: string) { return [...this.threads.values()].filter(t => t.kind === 'auto').length; }

  nextAutoConversationId() { return `auto:${++this.seq}`; }
}

function mirrorIsPrefix(mirror: Message[], messages: Message[]): boolean {
  if (mirror.length > messages.length) return false;
  for (let i = 0; i < mirror.length; i++) if (!sameMsg(mirror[i]!, messages[i]!)) return false;
  return true;
}
function sameMsg(a: Message, b: Message): boolean {
  return a.role === b.role && a.content === b.content
    && (a.tool_call_id ?? null) === (b.tool_call_id ?? null)
    && (a.name ?? null) === (b.name ?? null)
    && JSON.stringify(a.tool_calls ?? null) === JSON.stringify(b.tool_calls ?? null);
}
