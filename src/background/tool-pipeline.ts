import type { ToolChoice, ToolDef, ToolCall } from '../shared/api-types';
import { parseDsmlToolCalls, hasDsmlToolTags, firstToolBlockOpen } from './providers/deepseek/dsml-parser';


/** tools 透传给调用方：DSML 解析需要工具 schema 才能把 `string="false"` 参数转成正确类型。 */
export interface ToolContext { promptSuffix: string; tools: ToolDef[] }

export function buildToolPrompt(tools: ToolDef[], toolChoice: ToolChoice): ToolContext {
  if (!tools?.length || toolChoice === 'none') return { promptSuffix: '', tools: [] };
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
  return { promptSuffix: `\n\n${formatBlock}\n\n${defsBlock}\n\n${instructionBlock}\n`, tools };
}

/** 内容中是否存在"可能为工具调用"的标签块（用于区分"模型未调用工具"与"调用了但 JSON 解析失败"）。
 *  相比朴素 findBlocks，额外要求块内 JSON 至少能 coerce 出一个 ToolCall，避免纯文本提及 tool_calls 误判。 */
export function hasToolTags(content: string): boolean {
  // DSML（DeepSeek V4 原生协议）：包裹标记几乎不可能出现在普通散文里，直接认标记。
  if (hasDsmlToolTags(content)) return true;
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

/** Parse tool-call blocks. Returns null if no tag found or irrecoverable.
 *  `tools` 仅在 DSML 分支需要（按 schema 决定 `string="false"` 参数的类型）。 */
export function parseToolCalls(content: string, tools: ToolDef[] = []): { calls: ToolCall[]; remainder: string } | null {
  if (!content) return null;
  const blocks = findBlocks(content);
  // 2026-09-10（fix/dsml-namespace-optional）：findBlocks 会匹配上裸 `<tool_calls>`（命名空间被剥离
  // 的现场形态），但块体是 invoke 标记而非 JSON → parseBlocks 返回 null。原先 `return parseBlocks(...)`
  // 直接返回 null，永远走不到下面的 DSML 分支。改为 parseBlocks 失败时继续 fall through。
  if (blocks.length) {
    const tagged = parseBlocks(content, blocks);
    if (tagged) return tagged;
  }
  // 2026-09-10（fix/dsml-tool-parser）：DeepSeek V4 原生工具协议是 DSML
  // （<｜DSML｜tool_calls> / <｜DSML｜invoke name="X">）——vLLM parser 的 TS 移植，
  // 见 providers/deepseek/dsml-parser.ts。优先于下面的代码块/裸 JSON 兜底（那两个形状更宽松）。
  const dsml = parseDsmlToolCalls(content, tools);
  if (dsml) return { calls: dsml.calls, remainder: dsml.content };
  // 2026-09-15（fix/tool-call-recovery）：结构化恢复层——v0.2.5 piano 现场证明 repair 不是漂移的
  // 可靠兑底（重问后模型再次漂移 → 400 断链），而块体是人眼可读、可严格验证的（近乎）合法
  // OpenAI JSON。开标签锚定 + 平衡 JSON 提取 + inline args 修复，全部校验通过才恢复；
  // 任何一步失败仍返回 null（fail-closed，走 repair/400 不变）。详见 recoverUnclosedBlock。
  const recovered = recoverUnclosedBlock(content);
  if (recovered) return recovered;
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

// ——— 2026-09-15（fix/tool-call-recovery）结构化恢复层 ———
// 背景：v0.2.5 piano 现场——模型开标准 <tool_calls>（prompt 教的形态）+ 块体（近乎）合法的
// OpenAI JSON，收尾却是漂移形态的 DSML 闭标签，且 arguments 未按约定 stringify（内层引号
// 未转义）。此形态下前面所有层都解不出 → repair 重问，而现场证明模型重问后照样漂移 →
// 400 → agent 链断裂。原则细化（spec §4.4）：可验证的高置信恢复优先于重问——
// 开标签锚定 + 平衡 JSON 提取 + inline args 修复，每一步都可被严格校验（最终 JSON.parse
// 必须通过、每个元素必须 coerce 成 ToolCall），任何一步失败立即放弃走 fail-closed，
// 不做猜测性修复。

/** 从第一个工具块开标签起提取块体 JSON 并恢复调用；不可恢复返回 null（fail-closed）。
 *  remainder = 开标签之前的文本（开标签后的标记垃圾一并丢弃——现场形态闭标签都是结尾，
 *  块后正文与标记垃圾无法可靠区分，保守不保留）。 */
function recoverUnclosedBlock(content: string): { calls: ToolCall[]; remainder: string } | null {
  const open = firstToolBlockOpen(content);
  if (!open) return null;
  const body = content.slice(open.end);
  const jsonStart = body.search(/[{[]/);
  if (jsonStart === -1) return null;
  const jsonEnd = balancedEnd(body, jsonStart);
  if (jsonEnd === -1) return null;
  const parsed = tryParseJsonWithInlineArgs(body.slice(jsonStart, jsonEnd + 1));
  if (parsed === undefined) return null;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  for (const item of arr) {
    const tc = coerceToToolCall(item);
    // 任一元素不是合法工具调用 → 整体放弃（部分恢复会静默丢调用，对齐 review-r1 原则）
    if (!tc) return null;
    calls.push(tc);
  }
  if (!calls.length) return null;
  return { calls, remainder: content.slice(0, open.start) };
}

/** 引号/转义感知的括号配对：返回与 s[start] 配对的闭括号下标；括不平衡返回 -1。 */
function balancedEnd(s: string, start: number): number {
  const openCh = s[start];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 严格 parse；失败后尝试 inline args 修复再 parse；仍失败返回 undefined（调用方 fail-closed）。 */
function tryParseJsonWithInlineArgs(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { /* 继续尝试修复 */ }
  const fixed = repairInlineArguments(s);
  if (fixed === null) return undefined;
  try { return JSON.parse(fixed); } catch { return undefined; }
}

/** 修复 arguments 值内联对象形态（第 6 漂移形态）：模型没按约定把参数 stringify 后放
 *  字符串字段，而是直接内联对象，内层引号未转义：
 *    "arguments":"{"path":"a.ino"}"  →  "arguments":{"path":"a.ino"}
 *  做法：定位 `"arguments"\s*:\s*"\{`，从 `{` 起括号配对（引号状态在对象内**重新起算**——
 *  内层引号本来就没转义，外层字符串状态不可靠）到深度归零；要求值后紧跟收尾引号。
 *  混合形态（部分转义部分内联）不可靠 → 配对或重建失败即整体放弃（由最终 JSON.parse 兼底验证）。 */
function repairInlineArguments(s: string): string | null {
  const re = /"arguments"\s*:\s*"\{/g;
  let out = '';
  let cursor = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    const objStart = m.index + m[0].length - 1;   // 指向 `{`
    const objEnd = braceEnd(s, objStart);
    if (objEnd === -1 || s[objEnd + 1] !== '"') return null;
    out += s.slice(cursor, m.index) + '"arguments":' + s.slice(objStart, objEnd + 1);
    cursor = objEnd + 2;                          // 跳过原 string 值的收尾引号
    re.lastIndex = cursor;
  }
  if (cursor === 0) return null;                  // 一处都没匹配（调用方已先试过严格 parse）
  return out + s.slice(cursor);
}

/** 从 `{` 起括号配对（引号状态在对象内重新起算）；深度归零返回 `}` 下标，否则 -1。 */
function braceEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
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
          // 2026-09-09（fix/dsml-toolcalls）：Vision 可能输出多个紧贴 JSON 对象而非数组。
          // 在试单对象之前先试「以顶层对象边界切分」——在每个 }{ 边界处拆分为多个独立 JSON 解析。
          const split = splitConcatenatedObjects(repaired2);
          if (split.length > 0) {
            parsed = split;
          } else {
            const obj = tryParseSingleObject(repaired2);
            if (obj !== undefined) parsed = [obj];
            else continue;
          }
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
    // 2026-09-09（fix/dsml-toolcalls）：DeepSeek Vision DSML 包裹——全角 ｜（U+FF5C），
    // start 要求含 tool_calls 后缀（end 是 <｜｜DSML｜｜> 不带 tool_calls），防 start 误匹配 end。
    { start: /<｜｜DSML｜｜tool_calls>/, end: /<｜｜DSML｜｜>/ },
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

// 2026-09-09（fix/dsml-toolcalls）：Vision 输出可能为多个紧贴 JSON 对象 `{...}{...}{...}`，
// 不是合规 JSON。用顶层括号配对器逐个拆分后逐个 parse——不允许括号嵌套扫描时只计「非引号
// 非转义」的 { }。返回空数组表示不是「紧贴对象」形态，调用方走原有 tryParseSingleObject 兑底。
function splitConcatenatedObjects(s: string): unknown[] {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{')) return [];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const piece = trimmed.slice(start, i + 1);
        try {
          out.push(JSON.parse(piece));
        } catch {
          return [];
        }
        start = -1;
      } else if (depth < 0) {
        return [];
      }
    }
  }
  // 拆出 0 个表示不是紧贴对象形态（兑底走单对象试 parse）
  return out.length > 1 ? out : [];
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
