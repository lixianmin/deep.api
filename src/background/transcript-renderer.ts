import type { Message } from '../shared/api-types';
import { renderMessageContent } from './vision-pipeline';

export function limitCharsFor(modelType: 'default' | 'expert'): number {
  return modelType === 'expert' ? 163_840 : 2_621_440;
}

function mergeAdjacent(msgs: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role && msg.role !== 'tool' && !last.tool_calls && !msg.tool_calls) {
      last.content = `${last.content ?? ''}\n\n${msg.content ?? ''}`;
    } else {
      out.push({ ...msg });
    }
  }
  return out;
}

// DeepSeek 网页版 completion 接口的 prompt = 当前轮提问的纯文本；历史上下文由 parent_message_id 链维护。
// 不再使用 <｜user｜> 等模板标记（网页端会原样显示）。
function renderOne(msg: Message): string {
  // content 可能是 string / null / ContentBlock[]（vision）——统一渲染为纯文本。
  return renderMessageContent(msg);
}

// 2026-09-09（fix/full-tool-prompt）：tool_call_id → 函数名，用于「【工具结果 <name>】」标注。
// 反查同批 messages 里 assistant.tool_calls（OpenAI 形状）的 function.name；找不到就回退 unknown。
function toolNameFor(messages: Message[], toolMsg: Message): string {
  if (!toolMsg.tool_call_id) return 'unknown';
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      const tc = msg.tool_calls.find((t) => t.id === toolMsg.tool_call_id);
      if (tc) return tc.function.name;
    }
  }
  return 'unknown';
}

export function renderTranscript(
  messages: Message[],
): { ok: true; prompt: string } | { ok: false; reason: 'too-long'; limitChars: number; actualChars: number } {
  const merged = mergeAdjacent(messages);
  // system 折叠：拼到首条 user 消息前（用户决策：保留 system 效果的最小注入）
  const systems = merged.filter((msg) => msg.role === 'system').map((msg) => msg.content);

  // 2026-09-09（fix/full-tool-prompt）：旧实现只取「最后一条 user/tool」当 prompt——agent loop 第二轮
  // messages = [system, user(提问), asst(tool_calls), tool(结果1), tool(结果2)] 时只发最后一条 tool（sketch.ino），
  // diagram.json 结果丢失，模型误以为「用户新贴了空 sketch 代码」→ 第二轮重读文件 → spice 判无进展停止。
  // 修：全部 user + tool 消息按序入 prompt；tool 结果带「【工具结果 <函数名>】」标注，模型能识别
  // 这是「已读结果」而非新提问，直接在其上继续任务（写文件/编辑）。
  const parts: string[] = [];
  for (const msg of merged) {
    if (msg.role === 'system' || msg.role === 'assistant') continue;
    if (msg.role === 'user') parts.push(renderOne(msg));
    else if (msg.role === 'tool') parts.push(`【工具结果 ${toolNameFor(merged, msg)}】\n${renderOne(msg)}`);
  }
  const content = parts.join('\n\n');
  const sys = systems.length ? '【系统指令】\n' + systems.join('\n\n') + '\n\n' : '';
  return { ok: true, prompt: sys + content };
}

export function renderTail(tail: Message[]): string {
  const r = renderTranscript(tail);
  return r.ok ? r.prompt : '';
}
