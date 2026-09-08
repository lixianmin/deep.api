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

// DeepSeek 网页版 completion 接口的 prompt = 当前轮提问的纯文本；历史上下文由 parent_message_id 链维护。
// 不再使用 <｜user｜> 等模板标记（网页端会原样显示）。
function renderOne(msg: Message): string {
  return msg.content;
}

export function renderTranscript(
  messages: Message[],
): { ok: true; prompt: string } | { ok: false; reason: 'too-long'; limitChars: number; actualChars: number } {
  const merged = mergeAdjacent(messages);
  // system 折叠：拼到首条 user 消息前（用户决策：保留 system 效果的最小注入）
  const systems = merged.filter((msg) => msg.role === 'system').map((msg) => msg.content);
  // 取最后一条 user/tool 消息的纯文本作为本轮提问（历史依赖 parent_message_id 链）
  let last: Message | null = null;
  for (let i = merged.length - 1; i >= 0; i--) {
    const msg = merged[i];
    if (msg && (msg.role === 'user' || msg.role === 'tool')) { last = msg; break; }
  }
  const content = last ? renderOne(last) : '';
  const sys = systems.length ? '【系统指令】\n' + systems.join('\n\n') + '\n\n' : '';
  return { ok: true, prompt: sys + content };
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
