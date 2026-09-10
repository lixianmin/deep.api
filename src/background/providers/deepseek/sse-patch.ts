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
    // 2026-09-09（diag/pro-sse-paths）：流末 emit stream_stats 事件，Router 接手后写入 log。
    // 用于诊断 Pro（model_type=expert）在 DeepSeek 网页 web API 上是否只返 thinking fragments
    // （场景 B-1：bytes > 0 但 paths 只含 'response/fragments'+type='think'）还是用了未识别 path（场景 B-2：
    // paths 含 parser 不认识的 path）。bytes = 0 表示上游本就未返任何字节。
    yield { kind: 'stream_stats', bytes: stats.bytes, paths: [...stats.paths], rawSample: stats.raw };
  } finally {
    // best-effort 关闭底层迭代器；不 await：源停在未决 await 上时 spec 规定 return() 须等其完成（会死锁），故 fire-and-forget
    void iter.return?.().catch(() => {});
  }
}

function makeProcessor(onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void): {
  processBlock(block: string): ProviderStreamEvent[];
  stats: { bytes: number; paths: Set<string>; raw: string };
} {
  const tree = new ResponseTree();
  let sentReady = false;
  let lastPath: string | null = null;   // 简写增量 {"v":...} 的继承上下文
  let lastOp = 'SET';
  // 2026-09-09（diag/pro-sse-paths）：path 集（含 ready/request_message_id/response_message_id
  // 都记）。ready event 有顶层 request_message_id/response_message_id，不走 path 路径——加
  // 哨兵 'ready' 让 stats.paths 准确反映「上游到底返了什么」。
  const stats = { bytes: 0, paths: new Set<string>(), raw: '' as string };
  const processBlock = (block: string): ProviderStreamEvent[] => {
    const out: ProviderStreamEvent[] = [];
    for (const ev of parseSseText(block)) {
      // 2026-09-09（diag/raw-sample）：保留原始 SSE 文本前 600 字符，供诊断 Pro（expert）
      // 返回的未知事件（unknown:xxx）的真实内容。仅记录一次（raw === '' 时）。
      if (stats.raw.length < 600 && ev.data) {
        stats.raw += (stats.raw ? '\n' : '') + ev.data.slice(0, 600 - stats.raw.length);
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
          out.push(...tree.apply({ op, path, value: d.v }));
        } else if ('v' in d && typeof d.v !== 'object' && lastPath !== null) {
          // 形态2：简写增量（继承上个操作的 path/op）——不重复加 path（已在形态1加过）
          out.push(...tree.apply({ op: lastOp, path: lastPath, value: d.v }));
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
    return out;
  };
  return { processBlock, stats };
}
