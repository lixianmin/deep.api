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
  let buf = '';
  let lastActivity = Date.now();
  let sentReady = false;
  const tree = new ResponseTree();
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) throw new Error('stream timeout: no progress');
  }, 5000);
  try {
    for await (const chunk of body) {
      lastActivity = Date.now();
      buf += dec.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const ev of parseSseText(block)) {
          let data: unknown; try { data = JSON.parse(ev.data); } catch { continue; }
          if (!sentReady) {
            const ids = extractReadyIds(data);
            if (ids) { sentReady = true; onReady(ids); yield { kind: 'message_id', id: ids.responseMessageId }; continue; }
          }
          if (typeof data === 'object' && data !== null) {
            for (const [path, v] of Object.entries(data as Record<string, unknown>)) {
              if (typeof v === 'object' && v !== null) {
                const op = v as { op?: string; path?: string; value?: unknown };
                yield* tree.apply({ op: op.op ?? 'replace', path: op.path ?? path, value: op.value });
              }
            }
          }
        }
      }
    }
  } finally { clearInterval(timer); }
}
