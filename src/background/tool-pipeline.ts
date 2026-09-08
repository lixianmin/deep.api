import type { ToolChoice, ToolDef, ToolCall } from '../shared/api-types';

/** ds-free-api 默认工具标签范集（spec §4.4） */
export const TOOL_TAGS = {
  starts: ['<|tool_call_begin|>', '<tool_calls>', '<tool_call>'] as const,
  ends: ['<|tool_call_end|>', '</tool_calls>', '</tool_call>'] as const,
};

export interface ToolContext { promptSuffix: string }

export function buildToolPrompt(tools: ToolDef[], toolChoice: ToolChoice): ToolContext {
  if (!tools?.length || toolChoice === 'none') return { promptSuffix: '' };
  const defs = tools.map(t => `- ${t.function.name}${t.function.description ? `: ${t.function.description}` : ''}\n  参数 JSON Schema: ${JSON.stringify(t.function.parameters ?? {})}`).join('\n');
  const formatBlock = `### 格式规范
将工具调用输出为 JSON 数组，包裹在 <tool_calls>…</tool_calls> 内，每个元素形如：
{"id":"<id>","type":"function","function":{"name":"<name>","arguments":"<args-json-string>"}}
- arguments 必须是 JSON 字符串（外层先 stringify 再放进字符串字段）。`;
  const defsBlock = `### 工具定义\n${defs}`;
  const instruction = toolChoice === 'auto'
    ? '当需要工具时调用；可以零次或多次调用；最后给出一段自然语言总结。'
    : typeof toolChoice === 'object'
      ? `仅可调用工具 ${toolChoice.function.name}。`
      : '按需调用。';
  const instructionBlock = `### 调用指令\n${instruction}`;
  return { promptSuffix: `\n\n${formatBlock}\n\n${defsBlock}\n\n${instructionBlock}\n` };
}

/** 内容中是否存在工具调用标签（用于区分"模型未调用工具"与"调用了但 JSON 解析失败"）。 */
export function hasToolTags(content: string): boolean {
  return findBlocks(content).length > 0;
}

/** Parse tool-call blocks. Returns null if no tag found or irrecoverable. */
export function parseToolCalls(content: string): { calls: ToolCall[]; remainder: string } | null {
  if (!content) return null;
  const blocks = findBlocks(content);
  if (!blocks.length) return null;
  const calls: ToolCall[] = [];
  for (const { raw } of blocks) {
    const jsonStr = stripCodeFences(raw);
    let parsed: unknown = null;
    try { parsed = JSON.parse(jsonStr); } catch {
      const repaired1 = repairInvalidBackslashes(jsonStr);
      try { parsed = JSON.parse(repaired1); } catch {
        const repaired2 = repairUnquotedKeys(repaired1);
        try { parsed = JSON.parse(repaired2); } catch {
          // try wrapping object into array if parsed-like object
          const obj = tryParseSingleObject(repaired2);
          if (obj !== undefined) parsed = [obj];
          else continue;
        }
      }
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      const tc = coerceToToolCall(item);
      if (tc) calls.push(tc);
    }
  }
  if (!calls.length) return null;
  // Strip the matched blocks from remainder (fuzzy-tolerant, conservative: keep content outside matched regions).
  let remainder = content;
  for (const { start, end } of blocks.reverse()) {
    remainder = remainder.slice(0, start) + remainder.slice(end);
  }
  return { calls, remainder };
}

// ——— internal helpers ———

interface Located { start: number; end: number; raw: string }

function stripCodeFences(s: string): string {
  return s.replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length));
}

function findBlocks(content: string): Located[] {
  // 跳过代码块后再定位
  const masked = stripCodeFences(content);
  const out: Located[] = [];
  for (let i = 0; i < TOOL_TAGS.starts.length; i++) {
    const startTag = TOOL_TAGS.starts[i]!;
    const endTag = TOOL_TAGS.ends[i]!;
    let cursor = 0;
    while (true) {
      const idx = masked.indexOf(startTag, cursor);
      if (idx < 0) break;
      const endIdx = masked.indexOf(endTag, idx + startTag.length);
      if (endIdx < 0) break;
      const realStart = idx;
      const realEnd = endIdx + endTag.length;
      const raw = content.slice(realStart + startTag.length, endIdx);
      out.push({ start: realStart, end: realEnd, raw });
      cursor = realStart + 1;
    }
  }
  // 按 start 排序、合并重叠
  out.sort((a, b) => a.start - b.start);
  const merged: Located[] = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && b.start < last.end) continue;
    merged.push(b);
  }
  return merged;
}

function repairInvalidBackslashes(s: string): string {
  // 反斜杠后必须接合法 JSON 转义；常见模型错误：单反斜杠未转义
  return s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
}
function repairUnquotedKeys(s: string): string {
  // 给对象键补双引号（仅在 JSON 解析失败的回退中处理；保守：匹配 {key: ...} / , key: ...）
  return s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
}
function tryParseSingleObject(s: string): unknown | undefined {
  // 仅当整体像 JSON 对象（以 { 开头、以 } 结尾）时尝试
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}
function coerceToToolCall(v: unknown): ToolCall | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const f = o['function'] as Record<string, unknown> | undefined;
  if (!f || typeof f['name'] !== 'string') return null;
  const args = f['arguments'];
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  const id = typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : `call_${Math.random().toString(36).slice(2, 10)}`;
  return { id, type: 'function', function: { name: f['name'], arguments: argsStr } };
}
