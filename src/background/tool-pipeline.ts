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
    : toolChoice === 'required'
      ? '必须调用至少一个工具；不允许只给出纯文本回答（仅工具调用、不附总结也可）。'
      : typeof toolChoice === 'object'
        ? `仅可调用工具 ${toolChoice.function.name}。`
        : '按需调用。';
  const instructionBlock = `### 调用指令\n${instruction}`;
  return { promptSuffix: `\n\n${formatBlock}\n\n${defsBlock}\n\n${instructionBlock}\n` };
}

/** 内容中是否存在"可能为工具调用"的标签块（用于区分"模型未调用工具"与"调用了但 JSON 解析失败"）。
 *  相比朴素 findBlocks，额外要求块内 JSON 至少能 coerce 出一个 ToolCall，避免纯文本提及 tool_calls 误判。 */
export function hasToolTags(content: string): boolean {
  const blocks = findBlocks(content);
  if (!blocks.length) return false;
  for (const b of blocks) {
    const jsonStr = stripCodeFences(b.raw);
    let parsed: unknown = null;
    try { parsed = JSON.parse(jsonStr); } catch {
      const r1 = repairInvalidBackslashes(jsonStr);
      try { parsed = JSON.parse(r1); } catch {
        const r2 = repairUnquotedKeys(r1);
        try { parsed = JSON.parse(r2); } catch {
          const obj = tryParseSingleObject(r2);
          if (obj !== undefined) parsed = [obj];
        }
      }
    }
    if (parsed !== null) {
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) if (coerceToToolCall(item)) return true;
    }
  }
  return false;
}

/** Parse tool-call blocks. Returns null if no tag found or irrecoverable. */
export function parseToolCalls(content: string): { calls: ToolCall[]; remainder: string } | null {
  if (!content) return null;
  const blocks = findBlocks(content);
  if (blocks.length) return parseBlocks(content, blocks);
  // 无标签块 → fallback：模型可能用代码块包裹工具调用 JSON（本地实测 2026-09）
  const fence = findCodeFenceBlocks(content);
  if (fence.length) {
    const parsed = parseBlocks(content, fence);
    if (parsed) return parsed;
  }
  // 第三层 fallback：模型可能输出裸 JSON（整个 content 就是工具调用 JSON，无任何包裹——2026-09 实测）
  const bare = parseBareJson(content);
  if (bare) return bare;
  return null;
}

/** 尝试把整个 content 当作裸 JSON（对象/数组）解析为 ToolCall；非纯 JSON 返回 null。 */
function parseBareJson(content: string): { calls: ToolCall[]; remainder: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(trimmed); } catch {
    const r1 = repairInvalidBackslashes(trimmed);
    try { parsed = JSON.parse(r1); } catch {
      const r2 = repairUnquotedKeys(r1);
      try { parsed = JSON.parse(r2); } catch { return null; }
    }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  for (const item of arr) {
    const tc = coerceToToolCall(item);
    if (tc) calls.push(tc);
  }
  if (!calls.length) return null;
  // remainder：去掉 JSON 部分（保留前后文本）
  const start = content.indexOf(trimmed);
  return { calls, remainder: content.slice(0, start) + content.slice(start + trimmed.length) };
}

/** 解析已知块（标签块或代码块）为 ToolCall 数组；返回 null 表示块内容不是合法工具调用。 */
function parseBlocks(content: string, blocks: Located[]): { calls: ToolCall[]; remainder: string } | null {
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

/** 查找 ```json/``` 代码块（模型输出工具调用的常见形态；parseToolCalls 的 fallback）。 */
function findCodeFenceBlocks(content: string): Located[] {
  const out: Located[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[1] ?? '' });
  }
  return out;
}
function findBlocks(content: string): Located[] {
  // 跳过代码块后再定位（masked 保位不保内容，raw 从原 content 切片）
  const masked = stripCodeFences(content);
  const out: Located[] = [];
  const patterns: Array<{ start: RegExp; end: RegExp }> = [
    { start: /<\|tool_call_begin\|>/i, end: /<\|tool_call_end\|>/i },
    { start: /<{0,1}\s*tool_calls\s*>?/i, end: /<{0,1}\s*\/tool_calls\s*>?/i },   // 容忍缺 < / 空格 / 大小写
    { start: /<{0,1}\s*tool_call\s*>?/i, end: /<{0,1}\s*\/tool_call\s*>?/i },
  ];
  for (const { start: startRe, end: endRe } of patterns) {
    let cursor = 0;
    while (true) {
      const m = startRe.exec(masked.slice(cursor));
      if (!m) break;
      const idx = cursor + m.index;
      const after = masked.slice(idx + m[0].length);
      const em = endRe.exec(after);
      if (!em) break;
      const endIdx = idx + m[0].length + em.index;
      const realEnd = endIdx + em[0].length;
      const raw = content.slice(idx + m[0].length, endIdx);
      out.push({ start: idx, end: realEnd, raw });
      cursor = idx + 1;
    }
  }
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
