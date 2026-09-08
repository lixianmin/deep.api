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
  apply(op: { op: string; path: string; value?: unknown }): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = [];
    const value = (op.value ?? null) as unknown;
    if (op.path === 'response/fragments' && op.op === 'add' && value && typeof value === 'object') {
      const v = value as { type?: string; content?: string };
      const type = v.type === 'think' ? 'think' : 'response';
      this.fragments.push({ type, content: typeof v.content === 'string' ? v.content : '' });
      const created = this.fragments[this.fragments.length - 1]!;
      if (created.content) out.push({ kind: type === 'think' ? 'think_delta' : 'content_delta', content: created.content });
      return out;
    }
    if (op.path === 'response/fragments/-1/content' && typeof value === 'string') {
      const frag = this.fragments[this.fragments.length - 1];
      if (!frag) return out;
      frag.content += value;
      out.push({ kind: frag.type === 'think' ? 'think_delta' : 'content_delta', content: value });
      return out;
    }
    if ((op.path === 'response/content' || op.path === 'response/fragments/-1/content') && typeof value === 'string') {
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
  const { processBlock } = makeProcessor(onReady);
  const iter = body[Symbol.asyncIterator]();
  let buf = '';
  try {
    while (true) {
      const nextP = iter.next();
      let result: IteratorResult<Uint8Array>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 每轮消费都以 timeout 竞速：body 停顿时本轮 reject，消费者能收到超时错误（契约“无进度断流”）
        const timeoutP = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('stream timeout: no progress')), timeoutMs);
        });
        result = await Promise.race([nextP, timeoutP]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) break;
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
  } finally {
    // best-effort 关闭底层迭代器；不 await：源停在未决 await 上时 spec 规定 return() 须等其完成（会死锁），故 fire-and-forget
    void iter.return?.().catch(() => {});
  }
}

function makeProcessor(onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void): {
  processBlock(block: string): ProviderStreamEvent[];
} {
  const tree = new ResponseTree();
  let sentReady = false;
  let lastPath: string | null = null;   // 简写增量 {"v":...} 的继承上下文
  let lastOp = 'SET';
  const processBlock = (block: string): ProviderStreamEvent[] => {
    const out: ProviderStreamEvent[] = [];
    // 调试：打印原始 SSE block（仅本地排查；正式版可去掉）
    console.log('[deep.api sse]', block.slice(0, 400).replace(/\n/g, '\\n'));
    for (const ev of parseSseText(block)) {
      let data: unknown; try { data = JSON.parse(ev.data); } catch { continue; }
      if (!sentReady) {
        const ids = extractReadyIds(data);
        if (ids) { sentReady = true; onReady(ids); out.push({ kind: 'message_id', id: ids.responseMessageId }); continue; }
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
          out.push(...tree.apply({ op, path, value: d.v }));
        } else if ('v' in d && typeof d.v !== 'object' && lastPath !== null) {
          // 形态2：简写增量（继承上个操作的 path/op）
          out.push(...tree.apply({ op: lastOp, path: lastPath, value: d.v }));
        } else {
          // 形态3：旧格式 {op?,path?,value?} 或 {v:{快照}} 等：仅当子对象是 {op,path,value} 时解析
          for (const [key, v] of Object.entries(d)) {
            if (typeof v === 'object' && v !== null) {
              const op = v as { op?: string; path?: string; value?: unknown };
              if (typeof op.path === 'string') {
                const path = op.path;
                const o = op.op ?? 'replace';
                lastPath = path; lastOp = o;
                out.push(...tree.apply({ op: o, path, value: op.value }));
              }
            }
          }
        }
      }
    }
    return out;
  };
  return { processBlock };
}
