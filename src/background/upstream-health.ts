// 2026-10-01（feat/upstream-health）：上游响应健康度聚合。
//
// 动机（封号风险调研结论）：debug log 有逐条记录但没有任何聚合，事后无法回答
// 「我们到底有没有在被 DeepSeek 标记」。而这是所有防御性改动的前置观测条件——
// 没有它，压限流/加抖动都是盲改。
//
// 范围：只做「归类 + 计数 + 记住最后一次现场」。不告警、不自动降级、不改变任何请求行为
// （AGENTS.md §2：不做没被要求的投机设计）。

export type UpstreamEventKind =
  | 'ok'            // 2xx 且无异常信号
  | 'rate_limited'  // 429
  | 'auth'          // 401/403
  | 'waf'           // 带 x-amzn-waf-action：请求形态被拦
  | 'server_error'  // 5xx
  | 'bad_body'      // 2xx 但响应体是 HTML 而非 JSON（WAF 回 SPA 的已知形态）
  | 'network'       // fetch 抛错，连 HTTP 状态都没有
  | 'other';        // 其余未归类状态码

/** popup 按此顺序渲染（严重度从高到低），新增类型必须同时加进这里。 */
export const ALL_KINDS: UpstreamEventKind[] = ['waf', 'rate_limited', 'auth', 'bad_body', 'server_error', 'network', 'other', 'ok'];

export interface UpstreamCounts {
  ok: number; rate_limited: number; auth: number; waf: number;
  server_error: number; bad_body: number; network: number; other: number;
}

export interface UpstreamEventInfo {
  status?: number;
  /** 响应带 x-amzn-waf-action 头（DeepSeek WAF 命中）。 */
  waf?: boolean;
  /** 响应体是 HTML 而非 JSON——WAF 拦截的已知形态，HTTP 状态仍是 200。 */
  bodyIsHtml?: boolean;
  /** 现场补充说明（如响应体前 200 字），只给最后一次事件。 */
  detail?: string;
}

export interface UpstreamSnapshot {
  counts: UpstreamCounts & { total: number };
  lastAt: number;
  lastKind?: UpstreamEventKind;
  lastStatus?: number;
  lastDetail?: string;
  startedAt: number;
}

/**
 * 归类。顺序即优先级：waf 最高——它说明请求形态被拦，与「限流」「服务端故障」
 * 是完全不同性质的事，混在一起会误导排查（202 是 WAF 的正常返回码，只看 status 会误判成 ok）。
 */
export function classifyUpstream(info: UpstreamEventInfo): UpstreamEventKind {
  if (info.waf) return 'waf';
  const s = info.status ?? 0;
  if (s === 429) return 'rate_limited';
  if (s === 401 || s === 403) return 'auth';
  if (s >= 500) return 'server_error';
  if (info.bodyIsHtml) return 'bad_body';
  if (s >= 200 && s < 300) return 'ok';
  return 'other';
}

function emptyCounts(): UpstreamCounts {
  return { ok: 0, rate_limited: 0, auth: 0, waf: 0, server_error: 0, bad_body: 0, network: 0, other: 0 };
}

export class UpstreamHealth {
  private counts = emptyCounts();
  private lastAt: number;
  private lastKind?: UpstreamEventKind;
  private lastStatus?: number;
  private lastDetail?: string;
  /** SW 启动时刻（非 readonly：restore 会用持久化里的旧值覆盖，避免重启后计数看似归零）。 */
  private startedAt: number;

  constructor(private now: () => number = Date.now) {
    this.startedAt = this.now();
    this.lastAt = this.startedAt;
  }

  record(kind: UpstreamEventKind, info: UpstreamEventInfo = {}): void {
    this.counts[kind]++;
    this.lastAt = this.now();
    this.lastKind = kind;
    // 现场字段跟随「最后一次事件」：后续一次普通 ok 会清掉上一次的 WAF 细节，
    // 避免 popup 显示过期现场误导排查。
    this.lastStatus = info.status;
    this.lastDetail = info.detail;
  }

  snapshot(): UpstreamSnapshot {
    const total = ALL_KINDS.reduce((n, k) => n + this.counts[k], 0);
    return {
      counts: { ...this.counts, total },
      lastAt: this.lastAt,
      lastKind: this.lastKind,
      lastStatus: this.lastStatus,
      lastDetail: this.lastDetail,
      startedAt: this.startedAt,
    };
  }

  /**
   * 从 chrome.storage 恢复。MV3 SW 随时被回收，计数归零会让「上周被拦过几次」这类问题
   * 永远查不出来。逐字段校验：storage 可能被旧版本或人工改坏，不能让坏数据把 popup 打死。
   */
  restore(snap: unknown): void {
    if (!snap || typeof snap !== 'object') return;
    const s = snap as Partial<UpstreamSnapshot>;
    if (s.counts && typeof s.counts === 'object') {
      const c = emptyCounts();
      for (const k of ALL_KINDS) {
        const v = (s.counts as unknown as Record<string, unknown>)[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) c[k] = v;
      }
      this.counts = c;
    }
    if (typeof s.lastAt === 'number') this.lastAt = s.lastAt;
    if (typeof s.startedAt === 'number') this.startedAt = s.startedAt;
    // 未知类型不采纳——否则 counts 里会多出 popup 没定义过的 key
    this.lastKind = ALL_KINDS.includes(s.lastKind as UpstreamEventKind) ? s.lastKind as UpstreamEventKind : undefined;
    this.lastStatus = typeof s.lastStatus === 'number' ? s.lastStatus : undefined;
    this.lastDetail = typeof s.lastDetail === 'string' ? s.lastDetail : undefined;
  }
}
