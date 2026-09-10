import type { Message } from '../shared/api-types';
import { RingLog, type LogEntry } from './log';

// 2026-09-09（fix/mirror-hash）：commit 时算 mirror 内容 64-bit FNV-1a hash（同步轻量）。
// Chrome MV3 SW 没有 Node crypto.createHash 也不支持 subtle.digest 同步调用，
// 这里用 FNV-1a 64-bit 同步算法——十几行实现足够；目的是 O(n) 字段比对 → O(1) hash 比对。
// hash 16 hex（64-bit）够去重；剩余碰撞概率由后续 mirrorIsPrefix 兜底（命中后仍走字段比对
// 的写路径在「老持久化无 hash 时」已分支）。所以此 hash 只是「快速跳过」。
// 顺序敏感：JSON.stringify 保序，同前缀字节级一致 → hash 命中 → incremental。
// 归一 assistant content：spice 端发 OpenAI 风格 null，deep.api mirror 存的是 ''，
// 不归一则 hash 不等（v0.1.43 sameMsg 已把 ''/null 视为相等，hash 路径需同样归一）。
function fnv1a64(str: string): string {
  // FNV-1a 64-bit
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash = (hash ^ BigInt(str.charCodeAt(i))) & 0xffffffffffffffffn;
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function hashMirror(mirror: Message[]): string {
  const normalized = mirror.map((m) => m.content === '' ? { ...m, content: null as unknown as string } : m);
  return fnv1a64(JSON.stringify(normalized));
}

// hashMirror 不区分 role：system prompt 是调用方注入的指令，不参与「同一会话续聊」判定。
// 运维上线知识库后 mirror[0] 的 system 变化会让整 hash 不同（误判 rebuild）——
// 因此 hash 比对时双方各自剥掉 system 后再算（与 mirrorIsPrefix 的 system 豁免语义对齐）。
function hashExcludingSystem(messages: Message[]): string {
  return hashMirror(messages.filter((m) => m.role !== 'system'));
}

export interface ThreadEntry {
  providerId: string;       // 2026-09-09：持久化恢复需要重建 `providerId:conversationId` 键
  conversationId: string;
  webSessionId: string;
  parentMessageId: number | string | null;
  mirror: Message[];       // 已确认推进的消息序列（与网页线程内容一致，spec §4.3）
  mirrorHash?: string;     // 2026-09-09（fix/mirror-hash）：commit 时算 FNV-1a 64-bit 缓存。
                           // decide 时 hash 快路径 O(1) 替代 mirrorIsPrefix 的逐字段比对；
                           // 旧 commit/旧持久化数据无 hash，下一次 commit 时补算（向后兼容）。
  kind: 'auto' | 'named';
  idleSince: number;
  lastUsedAt: number;
  busy: boolean;
  // 2026-09-09（fix/model-switch-rebuild）：同一 conversation_id 中途切模型必须走 rebuild。
  // DeepSeek 网页 web API 一个 chat thread 不允许中途换 model_type（聊天前定模型）；
  // reuse 旧 session 会让 model_type 与 parent_message_id 链不一致。register/commit 时
  // 写入，decide 时比对，不一致 → rebuild 走 deleteSession+createSession+renderTranscript。
  // 未设置（undefined）：旧持久化 thread 走「不约束」路径，避免 SW 重启后首轮误 rebuild。
  modelType?: 'default' | 'expert' | 'vision';
}

export type Decision =
  | { action: 'incremental'; thread: ThreadEntry; tail: Message[] }
  | { action: 'rebuild'; existing: ThreadEntry | null }
  | { action: 'error'; code: 'invalid_request_error'; message: string };

// 2026-09-09（feat/debug-dashboard）：debug 页「线程」tab 行数据，由 SessionMapper.listThreads 返回。
// shape 是 ThreadEntry 的精简子集 + log 聚合（lastDecision/lastDecisionAt）。
// 注意：不暴露 mirror 原文（避免日志区把多 KB base64/JSON 贴进 AI prompt）。
export interface ThreadRow {
  conversationId: string;
  kind: 'auto' | 'named';
  mirrorLen: number;
  webSessionId: string;
  parentMessageId: string | number | null;
  lastUsedAt: number;
  busy: boolean;
  lastDecision?: 'rebuild' | 'incremental' | 'error';
  lastDecisionAt?: number;
}

export class SessionMapper {
  private threads = new Map<string, ThreadEntry>();
  private seq = 0;
  // 2026-09-09（feat/debug-dashboard）：panel.listThreads 用——遍历 threads.values() 时按 cid
  // 在 log.list() 里取最近一次 action，作为 ThreadRow.lastDecision（debug 页「决策现场」字段）。
  // 由 sw.ts 在 build() 时注入；测试可直接赋值。无 log 时 lastDecision/lastDecisionAt 省略。
  log?: RingLog;
  // 2026-09-09（fix/thread-persistence）：状态变更回调——sw.ts 挂 chrome.storage 持久化，
  // 重装扩展/刷新页面（MV3 SW 重启）后 threads 从数据层恢复，续聊仍对应 DeepSeek 同一会话。
  onPersist?: (snap: { seq: number; threads: ThreadEntry[] }) => void;
  constructor(
    private deps: { createSession(): Promise<{ webSessionId: string }>; deleteSession(id: string): Promise<void>; now(): number },
    private cfg: { poolSize: number; ttlMs: number },
  ) {}

  private key(providerId: string, conversationId: string) { return `${providerId}:${conversationId}`; }

  decide(providerId: string, messages: Message[], conversationId?: string, modelType?: 'default' | 'expert' | 'vision'): Decision {
    if (messages.length === 0) return { action: 'error', code: 'invalid_request_error', message: 'messages is empty' };
    // 2026-09-09（fix/model-switch-rebuild）：同一 cid 中途切模型 → rebuild。
    // t.modelType 未设置（老持久化 thread）跳过本检查，承诺在 commit 时补上。
    const modelMatches = (t: ThreadEntry): boolean => t.modelType === undefined || modelType === undefined || t.modelType === modelType;
    // 全量 messages（含末条）用于匹配：镜像 ⊆ messages 即命中；
    // 未在网页线程上的部分 = messages.slice(mirror.length)（含最新一条 user 消息）。
    // 2026-09-09（fix/mirror-hash）：commit 时已算 mirrorHash；decide 时 hash 快路径——
    // 对每个候选 thread t，比较 hashMirror(messages.slice(0, t.mirror.length)) 与 t.mirrorHash；
    // 命中即 prefix 字节级一致（JSON.stringify 保序），省 mirrorIsPrefix 的逐字段 O(n) 比对。
    // 旧 thread 无 hash 时降级到字段比对，向后兼容老持久化数据。
    if (conversationId) {
      const t = this.threads.get(this.key(providerId, conversationId));
      if (!t) return { action: 'rebuild', existing: null };
      const namedTail = messages.slice(t.mirror.length);
      const prefixOk = t.mirrorHash != null
        ? messages.length >= t.mirror.length
          && hashExcludingSystem(messages.slice(0, t.mirror.length)) === hashExcludingSystem(t.mirror)
        : mirrorIsPrefix(t.mirror, messages);
      if (prefixOk && modelMatches(t) && namedTail.length > 0 && (namedTail[0]!.role === 'user' || namedTail[0]!.role === 'tool')) {
        if (t.mirrorHash == null) t.mirrorHash = hashMirror(t.mirror);
        return { action: 'incremental', thread: t, tail: namedTail };
      }
      return { action: 'rebuild', existing: t };
    }
    let best: ThreadEntry | null = null;
    for (const t of this.threads.values()) {
      if (t.kind !== 'auto' || t.busy) continue;
      if (!modelMatches(t)) continue;
      const prefixOk = t.mirrorHash != null
        ? messages.length >= t.mirror.length
          && hashExcludingSystem(messages.slice(0, t.mirror.length)) === hashExcludingSystem(t.mirror)
        : mirrorIsPrefix(t.mirror, messages);
      if (!prefixOk) continue;
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

  register(providerId: string, conversationId: string, webSessionId: string, mirror: Message[], modelType?: 'default' | 'expert' | 'vision'): ThreadEntry {
    const t: ThreadEntry = {
      providerId, conversationId, webSessionId, parentMessageId: null,
      mirror: mirror.map(x => ({ ...x })),
      mirrorHash: hashMirror(mirror),
      kind: conversationId.startsWith('auto:') ? 'auto' : 'named',
      idleSince: this.deps.now(), lastUsedAt: this.deps.now(), busy: false,
      modelType,
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

  commit(providerId: string, conversationId: string, messages: Message[], webSessionId: string, parentMessageId: number | string | null, modelType?: 'default' | 'expert' | 'vision') {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) { this.register(providerId, conversationId, webSessionId, messages, modelType); return; }
    t.mirror = messages.map(x => ({ ...x }));
    t.mirrorHash = hashMirror(t.mirror);
    t.parentMessageId = parentMessageId;
    if (modelType !== undefined) t.modelType = modelType;   // commit 调用者总是带新 modelType，覆盖以保证该轮成功后状态一致
    t.busy = false;
    t.lastUsedAt = this.deps.now();
    t.idleSince = this.deps.now();
    this.persist();
    this.scheduleSweep();
  }

  // 2026-09-09（fix/evict-expired）：commit 后 60s 跑一次 sweep，
  // 清掉 TTL 过期 thread（TTL=30min 来自 ProviderConfig.ttlMinutes）。
  // 单 timer 实例，避免频繁 commit 时反复 setTimeout。
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweepAll();
    }, 60_000);
  }
  private async sweepAll(): Promise<void> {
    // 仅 deepseek provider 名下 thread（当前唯一 provider；多 provider 时扩展）
    const providers = new Set<string>();
    for (const k of this.threads.keys()) providers.add(k.split(':')[0]!);
    for (const pid of providers) await this.evictExpired(pid);
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
  // 2026-09-09（fix/persist-debounce）：spice agent loop 一次用户回合会多次 commit
  // （user turn + 工具循环内部轮）→ 100ms debounce 合并多次写为一次。
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.onPersist?.(this.serialize());
    }, 100);
  }

  stats() { return { threads: this.threads.size, busy: [...this.threads.values()].filter(t => t.busy).length }; }

  // 2026-09-09（feat/debug-dashboard）：panel.listThreads 后端聚合。
  // 输出 ThreadRow 列表，shape 由 spec §7.1 约定；lastDecision/lastDecisionAt 可选（thread
  // 尚无对应 log 条目时不输出）。注入 log 后才能填这两个字段；无 log 时仅输出基础字段。
  listThreads(): ThreadRow[] {
    const rows: ThreadRow[] = [];
    for (const t of this.threads.values()) {
      const row: ThreadRow = {
        conversationId: t.conversationId,
        kind: t.kind,
        mirrorLen: t.mirror.length,
        webSessionId: t.webSessionId,
        parentMessageId: t.parentMessageId,
        lastUsedAt: t.lastUsedAt,
        busy: t.busy,
      };
      if (this.log) {
        let bestAt = -1;
        let bestAction: LogEntry['action'] | undefined;
        for (const e of this.log.list()) {
          if (e.cid === t.conversationId && e.at > bestAt) {
            bestAt = e.at;
            bestAction = e.action;
          }
        }
        if (bestAction) {
          row.lastDecision = bestAction;
          row.lastDecisionAt = bestAt;
        }
      }
      rows.push(row);
    }
    return rows;
  }

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
 *  而 deep.api router finalize 存的是 ''（agg.content）。两种表示语义相同。
 *  vision 的 array content（ContentBlock[]）用 JSON 结构比较——不能渲染成文本比，
 *  否则 [text] 与 [text,image_url] 会被误判为同一 mirror。 */
function normContent(c: Message['content']): string | null {
  if (c === '' || c === undefined || c === null) return null;
  return typeof c === 'string' ? c : JSON.stringify(c);
}
