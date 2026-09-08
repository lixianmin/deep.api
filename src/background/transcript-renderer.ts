import type { Message } from '../shared/api-types';

export function limitCharsFor(modelType: 'default' | 'expert'): number {
  return modelType === 'expert' ? 163_840 : 2_621_440;
}

function mergeAdjacent(msgs: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role && msg.role !== 'tool' && !last.tool_calls && !msg.tool_calls) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      out.push({ ...msg });
    }
  }
  return out;
}

function renderOne(msg: Message): string {
  switch (msg.role) {
    case 'system':
      return `<｜System｜>\n${msg.content}`;
    case 'user':
      return `<｜user｜>\n${msg.content}`;
    case 'assistant':
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls
          .map((c) => `assistant-tool-call: ${JSON.stringify({ name: c.function.name, arguments: c.function.arguments })}`)
          .join('\n');
        return `<｜assistant｜>\n${calls}`;
      }
      return `<｜assistant｜>\n${msg.content}`;
    case 'tool':
      return `tool(${msg.tool_call_id ?? ''}): ${msg.content}`;
  }
}

export function renderTranscript(
  messages: Message[],
): { ok: true; prompt: string } | { ok: false; reason: 'too-long'; limitChars: number; actualChars: number } {
  const merged = mergeAdjacent(messages);
  const prompt = merged.map(renderOne).join('\n\n');
  return { ok: true, prompt };
}

export function renderTail(tail: Message[]): string {
  const r = renderTranscript(tail);
  return r.ok ? r.prompt : '';
}

export async function hashMessages(msgs: Message[]): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(msgs));
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
