// 2026-10-01（feat/upstream-health）：上游响应健康度聚合。
//
// 动机：debug log 有逐条记录但没有聚合，事后无法回答「我们到底有没有在被 DeepSeek 标记」。
// 本模块只做一件事：把每次上游响应归类计数 + 记住最后一次非 ok 事件的现场，供 popup 展示。
//
// 归类顺序即优先级：waf 最高（说明请求形态被拦，比限流严重），其后是限流/鉴权/服务端/坏体/正常。
import { describe, it, expect } from 'vitest';
import { classifyUpstream, UpstreamHealth, type UpstreamEventKind } from '../../src/background/upstream-health';

describe('classifyUpstream', () => {
  it('2xx 且无异常信号 → ok', () => {
    expect(classifyUpstream({ status: 200 })).toBe('ok');
  });

  it('带 x-amzn-waf-action 的响应判 waf（优先于 HTTP 状态）', () => {
    // 202 是 DeepSeek WAF 的正常返回码（见 client.ts classify.unavailable），
    // 单看 status 会误判成 ok；waf 头才是真正的信号。
    expect(classifyUpstream({ status: 202, waf: true })).toBe('waf');
    // 即使同时是 5xx，waf 也优先——被 WAF 拦与「服务端故障」是完全不同的两件事。
    expect(classifyUpstream({ status: 503, waf: true })).toBe('waf');
  });

  it('429 → rate_limited', () => {
    expect(classifyUpstream({ status: 429 })).toBe('rate_limited');
  });

  it('401/403 → auth', () => {
    expect(classifyUpstream({ status: 401 })).toBe('auth');
    expect(classifyUpstream({ status: 403 })).toBe('auth');
  });

  it('5xx → server_error', () => {
    expect(classifyUpstream({ status: 500 })).toBe('server_error');
    expect(classifyUpstream({ status: 502 })).toBe('server_error');
  });

  it('2xx 但响应体是 HTML 而非 JSON → bad_body（WAF 回 SPA 的已知形态）', () => {
    // memory 架构决策 #3/#4：X-Client-* 或 cookie 触发 WAF 时返回 SPA HTML，
    // HTTP 状态仍是 200。不单独识别的话，坏体会一路走到 JSON.parse 才炸，看不出是拦截。
    expect(classifyUpstream({ status: 200, bodyIsHtml: true })).toBe('bad_body');
  });

  it('未覆盖的 4xx（如 422）不误判为 ok，归 server_error 之外的 other', () => {
    expect(classifyUpstream({ status: 422 })).toBe('other');
    expect(classifyUpstream({ status: 418 })).toBe('other');
  });
});

describe('UpstreamHealth', () => {
  it('空快照全为 0，且 lastKind 为 undefined（SW 冷启动时 popup 不能显示 undefined）', () => {
    const h = new UpstreamHealth(() => 1000);
    const s = h.snapshot();
    expect(s.counts.ok).toBe(0);
    expect(s.counts.rate_limited).toBe(0);
    expect(s.lastKind).toBeUndefined();
    expect(s.startedAt).toBe(1000);
  });

  it('按类型累计计数', () => {
    const h = new UpstreamHealth(() => 1);
    h.record('ok');
    h.record('ok');
    h.record('rate_limited', { status: 429 });
    const s = h.snapshot();
    expect(s.counts.ok).toBe(2);
    expect(s.counts.rate_limited).toBe(1);
    expect(s.counts.total).toBe(3);
  });

  it('lastKind 记住最后一次事件的类型（ok 也算——要看的是「最近一次是什么」）', () => {
    const h = new UpstreamHealth(() => 1);
    h.record('rate_limited', { status: 429 });
    h.record('ok');
    expect(h.snapshot().lastKind).toBe('ok');
  });

  it('lastStatus / lastDetail 只在最后一次事件带上现场', () => {
    const h = new UpstreamHealth(() => 1);
    h.record('waf', { status: 202, detail: 'x-amzn-waf-action=challenge' });
    let s = h.snapshot();
    expect(s.lastStatus).toBe(202);
    expect(s.lastDetail).toBe('x-amzn-waf-action=challenge');
    // 后续 ok 不带现场 → 现场字段必须被清掉，不能残留上一次的 WAF 细节误导排查
    h.record('ok');
    s = h.snapshot();
    expect(s.lastStatus).toBeUndefined();
    expect(s.lastDetail).toBeUndefined();
  });

  it('record 走 now() 时钟，lastAt 随之推进', () => {
    let t = 500;
    const h = new UpstreamHealth(() => t);
    h.record('ok');
    t = 900;
    h.record('ok');
    expect(h.snapshot().lastAt).toBe(900);
  });

  it('restore 恢复计数与 startedAt（SW 被 Chrome 回收后重启，计数不能归零）', () => {
    const h = new UpstreamHealth(() => 2000);
    h.restore({ counts: { ok: 10, rate_limited: 2, auth: 0, waf: 1, server_error: 0, bad_body: 0, network: 0, other: 0 }, lastAt: 1500, lastKind: 'waf', lastStatus: 202, lastDetail: 'd', startedAt: 1000 });
    const s = h.snapshot();
    expect(s.counts.ok).toBe(10);
    expect(s.counts.rate_limited).toBe(2);
    expect(s.counts.waf).toBe(1);
    expect(s.startedAt).toBe(1000);
    expect(s.lastKind).toBe('waf');
  });

  it('restore 丢弃缺字段/类型错误的持久化数据（storage 可能被旧版本或人工改坏）', () => {
    const h = new UpstreamHealth(() => 2000);
    // counts 整体不是对象 → 视为空快照，不抛
    h.restore({ counts: null as any, lastAt: 1500, startedAt: 1000 });
    expect(h.snapshot().counts.total).toBe(0);
    // 未知事件类型不得进入 counters（否则 popup 渲染出没定义过的 key）
    h.restore({ counts: { ok: 1, bogus: 5 } as any, lastAt: 1, startedAt: 1 });
    expect((h.snapshot().counts as unknown as Record<string, number>).bogus).toBeUndefined();
    expect(h.snapshot().counts.ok).toBe(1);
  });

  it('snapshot 返回副本：外部改它不污染内部状态', () => {
    const h = new UpstreamHealth(() => 1);
    h.record('ok');
    const s = h.snapshot();
    s.counts.ok = 999;
    expect(h.snapshot().counts.ok).toBe(1);
  });
});

describe('UpstreamHealth: 封号风险视角', () => {
  it('network 事件单独计数（fetch 抛 TypeError，连 HTTP 状态都没有）', () => {
    const h = new UpstreamHealth(() => 1);
    h.record('network', { detail: 'Failed to fetch' });
    expect(h.snapshot().counts.network).toBe(1);
    expect(h.snapshot().lastStatus).toBeUndefined();
  });

  it('连续 waf 会被计数捕捉到——单看 log 容易漏，这是本模块存在的理由', () => {
    const h = new UpstreamHealth(() => 1);
    for (let i = 0; i < 5; i++) h.record('waf', { status: 202 });
    const s = h.snapshot();
    expect(s.counts.waf).toBe(5);
    expect(s.counts.ok).toBe(0);
  });

  it('事件类型全集稳定（新增类型必须显式加进 ALL_KINDS，popup 才有列可渲染）', () => {
    const h = new UpstreamHealth(() => 1);
    const kinds: UpstreamEventKind[] = ['ok', 'rate_limited', 'auth', 'waf', 'server_error', 'bad_body', 'network', 'other'];
    for (const k of kinds) h.record(k);
    const s = h.snapshot();
    for (const k of kinds) expect(s.counts[k]).toBe(1);
  });
});
