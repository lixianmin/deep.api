import type { ProviderStreamEvent } from '../adapter';

export interface SseEvent { event?: string; data: string }
export function parseSseText(text: string): SseEvent[] {
  return text.split(/\n\n+/).map(block => {
    const ev: { event?: string; data?: string } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) ev.data = line.slice(5).trimStart();
    }
    return ev;
  }).filter((e): e is SseEvent => e.data !== undefined && e.data !== '');
}

export function extractReadyIds(data: unknown): { requestMessageId: number; responseMessageId: number } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const a = o.request_message_id, b = o.response_message_id;
  if (typeof a === 'number' && typeof b === 'number') return { requestMessageId: a, responseMessageId: b };
  return null;
}

type Frag = { type: 'think' | 'response'; content: string };
export class ResponseTree {
  private fragments: Frag[] = [];
  private usage: number | null = null;
  // 2026-09-09（fix/snapshot-fragments）：嵌套快照 {"v":{"response":{"fragments":[...]}}}
  // ——v0.1.76 实测 Pro（expert）的内容就藏在这个形态里（sseRaw 现场），llmweb2api 也专门
  // 处理该分支。RESPONSE→content、THINK/THINKING→thinking；TIP/其它 type（UI 提示）跳过；
  // 同时把 fragments 推进 this.fragments，供后续 /-1/content 增量接续（否则增量全丢）。
  applySnapshot(d: Record<string, unknown>): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = [];
    const vObj = d.v as Record<string, unknown> | undefined;
    const response = vObj?.response as Record<string, unknown> | undefined;
    if (!response || typeof response !== 'object') return out;
    const frags = response.fragments;
    if (!Array.isArray(frags)) return out;
    for (const f of frags) {
      const t = (f as { type?: unknown }).type;
      const content = (f as { content?: unknown }).content;
      if (t === 'TIP' || t === 'INFO') continue;  // 2026-09-09（fix/snapshot-fragments）：UI 提示不进入模型输出
      // 2026-09-11（fix/review-r1）：空 content 的 fragment 也要推进 this.fragments——
      // 它与 APPEND 分支同一语义（只推进上下文，后续 /-1/content 增量接上）；旧实现先判空
      // 再跳过，导致快照给了空 THINK/RESPONSE frag 时后续增量因 frag 不存在被静默丢弃（空回复）。
      if (t === 'THINK' || t === 'THINKING') {
        this.fragments.push({ type: 'think', content: '' });
        if (typeof content === 'string' && content !== '') out.push({ kind: 'think_delta', content });
      } else if (t === 'RESPONSE' || t === 'response') {
        this.fragments.push({ type: 'response', content: '' });
        if (typeof content === 'string' && content !== '') out.push({ kind: 'content_delta', content });
      }
      // 其它 type（TIP/INFO/TEXT 等 UI 提示）不产生内容事件，也不推进 fragments
    }
    return out;
  }
  apply(op: { op: string; path: string; value?: unknown }): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = [];
    const value = (op.value ?? null) as unknown;
    // 2026-09-09（fix/append-fragments）：response/fragments 支持两种形态——
    // op='add' 单对象（旧）与 op='APPEND' 数组（新，thinking 长回复中途新增 fragment 批次）。
    // type 映射：'THINK'/'THINKING'/'think' → think；'RESPONSE'/'response'/其它 → response；
    // 'TIP' 等 UI 提示跳过（不做内容也不推进上下文）。与 applySnapshot 的映射保持一致。
    if (op.path === 'response/fragments' && (op.op === 'add' || op.op === 'APPEND') && value && typeof value === 'object') {
      const frags = Array.isArray(value) ? value : [value];
      for (const f of frags) {
        const t = (f as { type?: unknown }).type;
        const content = (f as { content?: unknown }).content;
        if (typeof content !== 'string') continue;
        if (t === 'TIP' || t === 'INFO') continue;  // UI 提示不进入模型输出
        const isThink = t === 'THINK' || t === 'THINKING' || t === 'think';
        this.fragments.push({ type: isThink ? 'think' : 'response', content: '' });
        // 空 content 的 frag 只推进上下文（后续 /-1/content 增量接上），不 emit 空 delta
        if (content !== '') out.push({ kind: isThink ? 'think_delta' : 'content_delta', content });
      }
      return out;
    }
    if (op.path === 'response/fragments/-1/content' && typeof value === 'string') {
      // 2026-09-11（fix/review-r1）：无 frag 上下文时不再静默丢弃——新建一个 response frag 接住内容
      // （旧注释里那个「新建 response frag」的兑底分支被这里的 early return 挡成了死代码）。
      let frag = this.fragments[this.fragments.length - 1];
      if (!frag) { frag = { type: 'response', content: '' }; this.fragments.push(frag); }
      frag.content += value;
      out.push({ kind: frag.type === 'think' ? 'think_delta' : 'content_delta', content: value });
      return out;
    }
    if (op.path === 'response/content' && typeof value === 'string') {
      // 实测 SSE：内容走 {"p":"response/content","o":"APPEND","v":"..."} + 连续增量 {"v":"..."}（继承 p/o）
      this.fragments.push({ type: 'response', content: value });
      out.push({ kind: 'content_delta', content: value });
      return out;
    }
    if (op.path === 'response/accumulated_token_usage' && typeof value === 'number') {
      this.usage = value;
      out.push({ kind: 'usage', inputTokens: 0, outputTokens: value });  // input 不可得，Router 层按 spec 决定是否透出
      return out;
    }
    return out;  // response/status 等其余路径暂不产生事件
  }
}

export async function* completionEvents(
  body: AsyncIterable<Uint8Array>, timeoutMs: number,
  onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void,
): AsyncIterable<ProviderStreamEvent> {
  const dec = new TextDecoder();
  const { processBlock, stats } = makeProcessor(onReady);
  const iter = body[Symbol.asyncIterator]();
  let buf = '';
  try {
    while (true) {
      const nextP = iter.next();
      let result: IteratorResult<Uint8Array>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 每轮消费都以 timeout 竞速：body 停顿时本轮 reject，消费者能收到超时错误（契约“无进度断流”）
        // 2026-09-11（fix/review-r1）：带 5xx status，mapErrStatic 才能归入 provider_unavailable 503
        // （spec §4.5）；裸 Error 会落成 500 internal_error。
        const timeoutP = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('stream timeout: no progress'), { status: 504 })), timeoutMs);
        });
        result = await Promise.race([nextP, timeoutP]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) break;
      stats.bytes += result.value.byteLength;
      buf += dec.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        yield* processBlock(block);
      }
    }
    // 流结束：flush 残余尾帧（无 \n\n 终止也解析，不静默丢失）
    buf += dec.decode();
    if (buf.trim() !== '') yield* processBlock(buf);
    // 2026-09-11（fix/incomplete-stream-error）：流末兜底——服务端显式终态不是 FINISHED
    // （实测有 INCOMPLETE；WIP 表示连接在生成中途断开）→ 发 stream_error，Router 报 503。
    // error 帧已给过信号时不重复发（stats.error 已置）。
    if (!stats.error) {
      const terminal = stats.lastStatus ?? stats.lastQuasi;
      if (terminal !== null && terminal !== 'FINISHED') {
        yield { kind: 'stream_error', message: `DeepSeek stream incomplete (status=${terminal})`, reason: 'incomplete_status' };
      }
    }
    // 2026-09-09（diag/pro-sse-paths）：流末 emit stream_stats 事件，Router 接手后写入 log。
    // 用于诊断 Pro（model_type=expert）在 DeepSeek 网页 web API 上是否只返 thinking fragments
    // （场景 B-1：bytes > 0 但 paths 只含 'response/fragments'+type='think'）还是用了未识别 path（场景 B-2：
    // paths 含 parser 不认识的 path）。bytes = 0 表示上游本就未返任何字节。
    yield { kind: 'stream_stats', bytes: stats.bytes, paths: [...stats.paths], rawSample: stats.raw, statusValues: stats.statusValues, thinkingChars: stats.thinkingChars, responseChars: stats.responseChars, rawTail: stats.rawTail, autoResume: stats.autoResume, hasPendingFragment: stats.hasPendingFragment };
  } finally {
    // best-effort 关闭底层迭代器；不 await：源停在未决 await 上时 spec 规定 return() 须等其完成（会死锁），故 fire-and-forget
    void iter.return?.().catch(() => {});
  }
}

function makeProcessor(onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void): {
  processBlock(block: string): ProviderStreamEvent[];
  stats: {
    bytes: number; paths: Set<string>; raw: string; rawTail: string;
    statusValues: string[]; thinkingChars: number; responseChars: number;
    error: { message: string; reason?: string } | null;
    lastStatus: string | null; lastQuasi: string | null;
    autoResume?: boolean; hasPendingFragment?: boolean;
  };
} {
  const tree = new ResponseTree();
  let sentReady = false;
  let lastPath: string | null = null;   // 简写增量 {"v":...} 的继承上下文
  let lastOp = 'SET';
  // 2026-09-09（diag/pro-sse-paths）：path 集（含 ready/request_message_id/response_message_id
  // 都记）。ready event 有顶层 request_message_id/response_message_id，不走 path 路径——加
  // 哨兵 'ready' 让 stats.paths 准确反映「上游到底返了什么」。
  // 2026-09-11（diag/continue-thinking）：spike 期间临时加——追踪 response/status value 列表、
  // THINK/RESPONSE fragment 字符累计、流末原始 SSE 尾部 600 字符。设计冻结后会改为 emit
  // 'continue_required' ProviderStreamEvent 替代。当前只观测，不消费 value。
  const stats = {
    bytes: 0,
    paths: new Set<string>(),
    raw: '' as string,
    rawTail: '' as string,
    statusValues: [] as string[],
    thinkingChars: 0,
    responseChars: 0,
    // 2026-09-11（fix/incomplete-stream-error）：断流判定状态——error 帧 / 显式终态 /
    // Continue 决策字段（auto_resume 实测在 click_behavior 帧里，与 status=INCOMPLETE 同现）。
    error: null as { message: string; reason?: string } | null,
    lastStatus: null as string | null,
    lastQuasi: null as string | null,
    autoResume: undefined as boolean | undefined,
    hasPendingFragment: undefined as boolean | undefined,
  };
  // 2026-09-11（fix/incomplete-stream-error）：response 元数据字段追踪（form1/form2/BATCH 共用）。
  const trackMeta = (path: string, value: unknown): void => {
    if (path === 'response/status' && typeof value === 'string') { stats.statusValues.push(value); stats.lastStatus = value; }
    else if (path === 'response/quasi_status' && typeof value === 'string') { stats.lastQuasi = value; }
    else if (path === 'response/has_pending_fragment' && typeof value === 'boolean') { stats.hasPendingFragment = value; }
  };
  const processBlock = (block: string): ProviderStreamEvent[] => {
    const out: ProviderStreamEvent[] = [];
    for (const ev of parseSseText(block)) {
      // 2026-09-09（diag/raw-sample）：保留原始 SSE 文本前 600 字符，供诊断 Pro（expert）
      // 返回的未知事件（unknown:xxx）的真实内容。仅记录一次（raw === '' 时）。
      if (stats.raw.length < 600 && ev.data) {
        stats.raw += (stats.raw ? '\n' : '') + ev.data.slice(0, 600 - stats.raw.length);
      }
      // 2026-09-11（diag/continue-thinking）：spike 期间临时记录尾部 600 字符，用于定位
      // thinking 截断点（response/status 终值、可能的 finish 事件、finish_reason 字段）。
      // 始终记录（不限次数，靠 ring buffer 截断），只占最后 600 字符。
      if (ev.data) {
        stats.rawTail = (stats.rawTail + (stats.rawTail ? '\n' : '') + ev.data).slice(-600);
      }
      let data: unknown; try { data = JSON.parse(ev.data); } catch { continue; }
      if (!sentReady) {
        const ids = extractReadyIds(data);
        if (ids) { sentReady = true; onReady(ids); stats.paths.add('ready'); out.push({ kind: 'message_id', id: ids.responseMessageId }); continue; }
      }
      if (typeof data === 'object' && data !== null) {
        // 实测 SSE 格式：{"p":"response/content","o":"APPEND","v":"你好"} 完整操作；
        // 连续增量 {"v":"！"} 省略 p/o（继承上式）；{"v":{"response":{...}}} 是快照（跳过）。
        // 兼容旧格式：顶层遍历 {op,path,value} 对象。
        const d = data as Record<string, unknown>;
        if (typeof d.p === 'string') {
          // 形态1：完整操作（p=path, o=op 可选, v=value）
          const path = d.p;
          const op = typeof d.o === 'string' ? d.o : 'SET';
          lastPath = path; lastOp = op;
          stats.paths.add(path);
          // 2026-09-11（fix/incomplete-stream-error）：BATCH 批操作（实测：
          // {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":N},
          // {"p":"quasi_status","v":"INCOMPLETE"}]}）。子项 path 相对 response/，旧实现整帧
          // 丢弃——usage 静默丢失、quasi_status 终态无法判定。逐子项解包走同一套 apply/track。
          if (path === 'response' && op === 'BATCH' && Array.isArray(d.v)) {
            for (const sub of d.v) {
              const so = sub as { p?: unknown; o?: unknown; v?: unknown };
              if (typeof so.p !== 'string') continue;
              const subPath = so.p === 'response' || so.p.startsWith('response/') ? so.p : `response/${so.p}`;
              const subOp = typeof so.o === 'string' ? so.o : 'SET';
              trackMeta(subPath, so.v);
              out.push(...tree.apply({ op: subOp, path: subPath, value: so.v }));
            }
          } else {
            trackMeta(path, d.v);
            out.push(...tree.apply({ op, path, value: d.v }));
          }
        } else if ('v' in d && typeof d.v !== 'object' && lastPath !== null) {
          // 形态2：简写增量（继承上个操作的 path/op）——不重复加 path（已在形态1加过）
          trackMeta(lastPath, d.v);
          out.push(...tree.apply({ op: lastOp, path: lastPath, value: d.v }));
        } else if (d.type === 'error' && typeof d.content === 'string') {
          // 2026-09-11（fix/incomplete-stream-error）：服务端中途错误帧（实测：
          // {"type":"error","content":"Server is temporarily unavailable.",
          // "finish_reason":"generation_err"}；Pro 旧案 "unsupported_client_by_model" 同形）。
          // 旧实现落进 unknown 兜底被丢 → 空回复当成功。改为显式事件，Router 流末报 503。
          const reason = typeof d.finish_reason === 'string' ? d.finish_reason : undefined;
          stats.error = { message: d.content, reason };
          stats.paths.add('error_frame');
          out.push({ kind: 'stream_error', message: d.content, reason });
        } else if (
          (typeof d.auto_resume === 'boolean') || (typeof d.click_behavior === 'string')
        ) {
          // 2026-09-11（fix/incomplete-stream-error）：click_behavior 帧（实测：
          // {"click_behavior":"none","auto_resume":false}）。auto_resume 是网页 UI
          // 是否给 Continue 按钮的决策字段，先入诊断；对象形态（如 {"click_behavior":{...}}）
          // 不消费，仍走 unknown 兑底保留诊断粒度。
          if (typeof d.auto_resume === 'boolean') stats.autoResume = d.auto_resume;
          stats.paths.add('click_behavior_frame');
        } else {
          // 形态3：旧格式 {op?,path?,value?} 或 {v:{快照}} 等：仅当子对象是 {op,path,value} 时解析
          let parsedAny = false;
          for (const [key, v] of Object.entries(d)) {
            if (typeof v === 'object' && v !== null) {
              const op = v as { op?: string; path?: string; value?: unknown };
              if (typeof op.path === 'string') {
                const path = op.path;
                const o = op.op ?? 'replace';
                lastPath = path; lastOp = o;
                stats.paths.add(path);
                out.push(...tree.apply({ op: o, path, value: op.value }));
                parsedAny = true;
              }
            }
          }
          if (!parsedAny) {
            // 2026-09-09（fix/snapshot-fragments）：先试嵌套快照（Pro 内容藏在这里），再落 unknown 兜底
            const snap = tree.applySnapshot(d);
            if (snap.length > 0) {
              stats.paths.add('snapshot:fragments');
              // 快照解析后，后续简写增量 {"v":"..."} 应接续到最后一个 RESPONSE/THINK
              // fragment 的 /-1/content（与形态2继承逻辑一致）；快照本身没有 p/o 上下文。
              lastPath = 'response/fragments/-1/content';
              lastOp = 'APPEND';
              out.push(...snap);
            } else {
              // 形态3 没匹配上：记录未知顶层 key 以便诊断 Pro 是否有新 path
              const unknownKey = Object.keys(d)[0] ?? 'unknown';
              stats.paths.add(`unknown:${unknownKey}`);
            }
          }
        }
      }
    }
    // 2026-09-11（diag/continue-thinking）：spike 期间累计 THINK/RESPONSE fragment 字符数——
    // 用于探测 thinking 截断阈值（如「thinking > 80K → 触发 Continue」）。每帧累加成本 O(events)
    // 可忽略；不与 tree.fragments 同步避免双源。
    for (const e of out) {
      if (e.kind === 'think_delta') stats.thinkingChars += e.content.length;
      else if (e.kind === 'content_delta') stats.responseChars += e.content.length;
    }
    return out;
  };
  return { processBlock, stats };
}
