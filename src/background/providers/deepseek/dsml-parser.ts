/**
 * DSML（DeepSeek Markup Language）工具调用解析 —— vLLM 的 TypeScript 移植。
 *
 * 来源（Apache-2.0，Copyright contributors to the vLLM project）：
 *   - vllm v0.21.0 `vllm/tool_parsers/deepseekv32_tool_parser.py`（DeepSeekV32ToolParser：解析核心）
 *   - vllm v0.21.0 `vllm/tool_parsers/deepseekv4_tool_parser.py`（V4 只覆盖包裹名）
 *   - vllm v0.21.0 `vllm/tool_parsers/utils.py`（partial_tag_overlap）
 * 语法规范另见 DeepSeek 官方 V4 编码实现 `deepseek_v4_encoding.py`：
 *   dsml_token = "｜DSML｜"（全角 ｜ U+FF5C，大写 DSML），
 *   `<｜DSML｜tool_calls>` 包裹，`<｜DSML｜invoke name="X">` 单调用，
 *   `<｜DSML｜parameter name="K" string="true|false">V</｜DSML｜parameter>` 参数
 *   （string="true" → 字面字符串；"false" → 按 JSON/schema 类型解释）。
 * V4 用 `tool_calls` 作为包裹名，V3.2 用 `function_calls` —— 两者都接受。
 *
 * 与上游的两处刻意偏差（都有注释标注）：
 *   1. 命名空间匹配放宽为「大小写不敏感 + 全角 ｜ 与 ASCII | 等价」——现场见过小写漂移形态。
 *   2. 非流式的 `content` 保留块外全部文本（本仓库 remainder 语义），不采用 vLLM 的
 *      「截断到第一个块」语义，避免丢掉块后的正文。
 *   3. 2026-09-10（fix/dsml-namespace-optional）：**命名空间整体可选**（开/闭标签都是）。
 *      权威实现都把它当字面量写死（vLLM 的 regex、llama.cpp build_grammar），但 v0.1.97 现场
 *      replySample 整段没有 ｜DSML｜——沿用「必须带命名空间」等于链式失败：
 *      hasDsmlToolTags=false → hasToolTags=false → router 判「模型没调工具」→ 静默 stop。
 */

import type { ToolCall, ToolDef } from '../../../shared/api-types';

/** 规范 token（全角 ｜ U+FF5C，大写 DSML）。匹配时放宽（见文件头偏差说明）。 */
export const DSML_TOKEN = '｜DSML｜';

/** 命名空间**必需**片段：`[|｜]dsml[|｜]`，配合 `i` 标志同时容忍大小写与 ASCII 竖线。 */
const NS_REQUIRED = '[|｜]dsml[|｜]';
/** 命名空间**可选**（现场字节里它经常整段不在，见文件头偏差 3）。 */
const NS = `(?:${NS_REQUIRED})?`;

function blockRe(): RegExp {
  // 反引用 \1 保证起止包裹名一致（tool_calls 配 tool_calls）。
  // 2026-09-10（fix/dsml-tolerant-closes）：闭标签的命名空间**可选**——现场日志里模型开标签带
  // ｜DSML｜、闭标签却是普通的 </tool_calls> / </invoke> / </parameter>。
  // 2026-09-10（fix/dsml-namespace-optional）：开标签的命名空间同样可选——现场 replySample 整段没有 ｜DSML｜。
  return new RegExp(`<${NS}(tool_calls|function_calls)>([\\s\\S]*?)</${NS}\\1>`, 'gi');
}
function blockStartRe(): RegExp {
  return new RegExp(`<${NS}(tool_calls|function_calls)>`, 'i');
}
/** 只认带命名空间的块起始（用来区分「确定是 DSML」与「正文恰好提到 <tool_calls>」）。 */
function namespacedBlockStartRe(): RegExp {
  return new RegExp(`<${NS_REQUIRED}(tool_calls|function_calls)>`, 'i');
}
function invokeRe(): RegExp {
  return new RegExp(`<${NS}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${NS}invoke>`, 'gi');
}
function paramRe(): RegExp {
  return new RegExp(`<${NS}parameter\\s+name="([^"]+)"\\s+string="(true|false)"\\s*>([\\s\\S]*?)</${NS}parameter>`, 'gi');
}
/** invoke/parameter 标记（命名空间可选）。普通散文里不会出现，用来区分「块体是工具标记」与「正文提到 <tool_calls>」。 */
function invokeMarkRe(): RegExp {
  return new RegExp(`<${NS}(?:invoke|parameter)\\s+name=`, 'i');
}

export interface DsmlParseResult { calls: ToolCall[]; content: string }

/** 非流式解析：返回结构化 tool_calls + 去掉块的文本；没有可解析调用时返回 null。 */
export function parseDsmlToolCalls(text: string, tools: ToolDef[] = []): DsmlParseResult | null {
  if (!text) return null;
  const spans: Array<{ start: number; end: number; body: string }> = [];
  for (const m of text.matchAll(blockRe())) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, body: m[2] ?? '' });
  }
  if (!spans.length) {
    // 2026-09-10（fix/dsml-tolerant-closes）：容错——只有起始标记、没有块闭标签
    // （模型写完 invoke 就直接停/被截断）。起始标记之后全部当块体。
    const m = blockStartRe().exec(text);
    if (!m) return null;
    spans.push({ start: m.index, end: text.length, body: text.slice(m.index + m[0].length) });
  }
  const calls: ToolCall[] = [];
  for (const span of spans) calls.push(...parseInvokes(span.body, tools));
  if (!calls.length) return null;
  // remainder：剥掉所有块、保留块外文本（本仓库语义，见文件头偏差 2）
  let content = '';
  let cursor = 0;
  for (const s of spans) { content += text.slice(cursor, s.start); cursor = s.end; }
  content += text.slice(cursor);
  return { calls, content };
}

/** 文本里是否存在 DSML 工具调用标记（给 hasToolTags 用：区分「没调工具」与「调了但解析失败」）。
 *  2026-09-10（fix/dsml-namespace-optional）：不能只认块起始——命名空间被剥离后，裸 `<tool_calls>`
 *  与正文里单纯提到它的句子无法区分（那会误触发 repair）。改为「带命名空间的块起始」或
 *  「invoke/parameter 标记」二者其一——后两者不会出现在普通散文里。 */
export function hasDsmlToolTags(text: string): boolean {
  if (!text) return false;
  return namespacedBlockStartRe().test(text) || invokeMarkRe().test(text);
}

export interface DsmlStreamNormalizer {
  /** 送入一个内容增量，返回可安全发给客户端的文本（DSML 已在内部被缓冲）。 */
  feed(delta: string): string;
  /** 流结束：吐出残留文本（未闭合的**工具标记**块按 fail-closed 处理，不进输出）。 */
  flush(): string;
  /** 归一化失败的工具标记块原文（**绝不透传**给使用方；router 拿它作 repair 输入）。 */
  unparsed: string[];
}

/**
 * 流式归一化器：块外文本逐段即时透传（只扣住可能是起始标记前缀的尾巴），
 * 块内文本缓冲到结束标记，然后整块重写成标准 `<tool_calls>[…]</tool_calls>` JSON ——
 * 使用方（spice）按标准格式解析，永远看不到 DSML。
 *
 * 2026-09-10（fix/dsml-no-silent-leak）：解析不出的块不再 fail-open 原样吐出，改为扣进
 * `unparsed`（旧行为把 DSML 原文当正文发给下游，而流式路径没有 repair → 静默 stop）。
 * 唯一例外：块**无命名空间且块体里没有任何 invoke/parameter 标记** → 判为正文里恰好提到
 * `<tool_calls>`，原样透传（否则会把普通散文吞掉，并误触发一次 repair）。
 */
export function createDsmlStreamNormalizer(tools: ToolDef[] = []): DsmlStreamNormalizer {
  // 裸起始标记也要扣住尾巴：命名空间被剥离时 <tool_calls> 可能正好被 delta 切断。
  const startTokens = [
    `<${DSML_TOKEN}tool_calls>`, `<${DSML_TOKEN}function_calls>`,
    '<tool_calls>', '<function_calls>',
  ];
  const unparsed: string[] = [];
  let pending = '';
  let open: { startText: string; endRe: RegExp; namespaced: boolean } | null = null;
  let blockBody = '';

  /** 块无法归一化时：是工具标记 → 扣进 unparsed；只是正文提到 <tool_calls> → 原样透传。 */
  function discardOrPassThrough(raw: string, namespaced: boolean): string {
    if (namespaced || invokeMarkRe().test(raw)) { unparsed.push(raw); return ''; }
    return raw;
  }

  function feed(delta: string): string {
    let out = '';
    pending += delta;
    for (;;) {
      if (!open) {
        const m = blockStartRe().exec(pending);
        if (!m) {
          // 扣住「可能是起始标记前缀」的尾巴，避免标记被 delta 切断时泄漏半个标签
          const hold = maxOverlap(pending, startTokens);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          return out;
        }
        out += pending.slice(0, m.index);
        pending = pending.slice(m.index + m[0].length);
        open = { startText: m[0], endRe: new RegExp(`</${NS}${m[1]}>`, 'i'), namespaced: namespacedBlockStartRe().test(m[0]) };
        blockBody = '';
        continue;
      }
      const em = open.endRe.exec(pending);
      if (!em) { blockBody += pending; pending = ''; return out; }
      blockBody += pending.slice(0, em.index);
      pending = pending.slice(em.index + em[0].length);
      const raw = open.startText + blockBody + em[0];
      const normalized = normalizeBlock(blockBody, tools);
      out += normalized ?? discardOrPassThrough(raw, open.namespaced);
      open = null;
      blockBody = '';
    }
  }

  function flush(): string {
    if (!open) { const t = pending; pending = ''; return t; }
    // 2026-09-10（fix/dsml-tolerant-closes）：未闭合块先尝试归一化——模型常常写完 invoke
    // 就直接结束（不带块闭标签）。归一化仍失败时按 fail-closed 处理，不再原样吐出。
    const inner = blockBody + pending;
    const { startText, namespaced } = open;
    open = null; blockBody = ''; pending = '';
    return normalizeBlock(inner, tools) ?? discardOrPassThrough(startText + inner, namespaced);
  }

  return { feed, flush, unparsed };
}

/** text 后缀与任一 token 前缀的最长匹配长度（容忍大小写/竖线漂移，长度按原串计）。 */
function maxOverlap(text: string, tokens: string[]): number {
  const tail = unify(text.slice(-MAX_TOKEN_LEN));
  let max = 0;
  for (const token of tokens) {
    const t = unify(token);
    for (let k = Math.min(t.length - 1, tail.length); k > max; k--) {
      if (tail.endsWith(t.slice(0, k))) { max = k; break; }
    }
  }
  return max;
}

/** 最长 token 长度（`</｜DSML｜function_calls>` 共 24 字符），用于限制前缀比较的窗口。 */
const MAX_TOKEN_LEN = 24;

/** 小写化 + ASCII | 归一到全角 ｜（仅用于比较，不会写回输出）。 */
function unify(s: string): string {
  return s.replace(/\|/g, '｜').toLowerCase();
}

/** vLLM `utils.partial_tag_overlap`：tag 的最长前缀 === text 的后缀的长度，完整匹配返回 0。 */
export function partialTagOverlap(text: string, tag: string): number {
  const max = Math.min(tag.length - 1, text.length);
  for (let k = max; k > 0; k--) if (text.endsWith(tag.slice(0, k))) return k;
  return 0;
}

// ——— internal ———

/** 把一个 DSML 块体解析成结构化调用；没有可解析 invoke 时返回 null。 */
function parseInvokes(body: string, tools: ToolDef[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of body.matchAll(invokeRe())) {
    const name = m[1] ?? '';
    const params = parseParamDict(m[2] ?? '');
    calls.push({
      id: newToolCallId(),
      type: 'function',
      function: { name, arguments: JSON.stringify(convertParams(name, params, tools)) },
    });
  }
  return calls;
}

/** 整块重写成标准 `<tool_calls>` 文本；解析不出调用时返回 null。 */
function normalizeBlock(body: string, tools: ToolDef[]): string | null {
  const calls = parseInvokes(body, tools);
  if (!calls.length) return null;
  return `<tool_calls>\n${JSON.stringify(calls)}\n</tool_calls>`;
}

type ParamEntry = [name: string, value: string, stringAttr: 'true' | 'false'];

function parseParamDict(invokeBody: string): ParamEntry[] {
  const out: ParamEntry[] = [];
  for (const m of invokeBody.matchAll(paramRe())) {
    out.push([m[1] ?? '', m[3] ?? '', ((m[2] ?? 'true').toLowerCase() === 'false' ? 'false' : 'true')]);
  }
  return out;
}

/** 对齐 vLLM `_convert_params_with_schema`：string="true" 保原样，否则按 schema 声明类型转换。 */
function convertParams(name: string, params: ParamEntry[], tools: ToolDef[]): Record<string, unknown> {
  const props = findToolProperties(tools, name);
  const converted: Record<string, unknown> = {};
  for (const [key, value, stringAttr] of params) {
    if (stringAttr === 'true') { converted[key] = value; continue; }
    converted[key] = coerceDsmlValue(value, declaredType(props[key]));
  }
  return repairParamDict(converted, props);
}

function findToolProperties(tools: ToolDef[], name: string): Record<string, unknown> {
  for (const tool of tools) {
    if (tool?.function?.name !== name) continue;
    const params = tool.function.parameters as { properties?: unknown } | undefined;
    const props = params && typeof params === 'object' ? params.properties : undefined;
    return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
  }
  return {};
}

function declaredType(propSchema: unknown): string {
  if (propSchema && typeof propSchema === 'object') {
    const t = (propSchema as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return 'string';
}

/** 对齐 vLLM `_convert_param_value_checked`：null / int / number / bool / JSON，失败回退原文。 */
function coerceDsmlValue(value: string, type: string): unknown {
  if (value.trim().toLowerCase() === 'null') return null;
  switch (type.toLowerCase()) {
    case 'string': case 'str': case 'text':
      return value;
    case 'integer': case 'int': {
      const n = Number.parseInt(value, 10);
      return Number.isNaN(n) ? value : n;
    }
    case 'number': case 'float': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean': case 'bool': {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return value;
    }
    default:
      try { return JSON.parse(value); } catch { return value; }
  }
}

/** 对齐 vLLM `_repair_param_dict`：只有一个 arguments/input 键且非 schema 字段时，展开它。 */
function repairParamDict(dict: Record<string, unknown>, props: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(dict);
  if (keys.length !== 1) return dict;
  const wrapper = keys[0]!;
  if (wrapper !== 'arguments' && wrapper !== 'input') return dict;
  const allowed = new Set(Object.keys(props));
  if (allowed.has(wrapper)) return dict;
  let inner = dict[wrapper];
  if (typeof inner === 'string') {
    try { inner = JSON.parse(inner); } catch { return dict; }
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return dict;
  const innerKeys = Object.keys(inner as Record<string, unknown>);
  return innerKeys.every((k) => allowed.has(k)) ? (inner as Record<string, unknown>) : dict;
}

/** 对齐 vLLM `_generate_tool_call_id`：`call_` + 24 位十六进制。 */
function newToolCallId(): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `call_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
