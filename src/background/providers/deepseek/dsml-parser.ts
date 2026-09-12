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
 *   4. 2026-09-10（fix/dsml-bar-run）：命名空间两侧的竖线放宽成 **1 个或多个**，容忍其后的空白，
 *      并额外接受包裹名 `calls`。依据是 v0.1.100 现场 `rawB64`（经 base64 字节级对齐）：
 *      两侧各 2 个 ｜、DSML 与标签名之间多一个空格、包裹名是 `calls`（`tool_` 整段不在）。
 *      网页 API 没有 guided decoding（官方服务端有），模型是在自己学的分布上复现这个特殊标记，
 *      所以形态会持续漂移——因此**检测判据刻意宽于解析判据**，解析不出的仍走 repair/400，绝不静默透传。
 *   5. 2026-09-15（fix/dsml-close-tag-detect）：**检测认闭标签形态**。v0.2.4 spice 现场：模型开
 *      标准 <tool_calls>（prompt 教的形态）+ 合法 OpenAI JSON，收尾却幻觉出漂移形态的 DSML
 *      **闭标签**（`</｜｜DSML｜｜ parameter>` 等，`<` 与竖线之间有 `/`）。旧检测模式要求
 *      `<` 后紧跟竖线，全部脱靶 → hasToolTags=false → 判「没调工具」→ 静默 stop + 原文透传。
 *      修法：仅检测正则 `<` 放宽为 `</?`；解析正则不变（仍严格），解析不出照旧 repair/400。
 */

import type { ToolCall, ToolDef } from '../../../shared/api-types';

/** 规范 token（全角 ｜ U+FF5C，大写 DSML）。匹配时放宽（见文件头偏差说明）。 */
export const DSML_TOKEN = '｜DSML｜';

/**
 * 命名空间里的竖线串：**1 个或多个**全角 ｜ 或 ASCII |。
 * 2026-09-10（fix/dsml-bar-run）：现场 rawB64 经 base64 字节级对齐后，两侧各是 **2 个**（不是 1 个）。
 */
const BARS = '[|｜]+';
/** 命名空间片段（可选）+ 其后的空白。现场：`<` + 两竖线 + DSML + 两竖线 + **空格** + 标签名。 */
const NS = `(?:${BARS}DSML${BARS})?\\s*`;
/**
 * 工具调用包裹标签名。`calls` 是现场实测形态——`tool_` 整段不在（原因未知，见文件头偏差 4）；
 * 不写成通配是因为 `calls` 这类词可能在普通散文里出现，宽松判定留在检测层（见 dsmlMarkerRe）。
 * 保留**捕获组**：blockStartRe 靠 m[1] 拿包裹名去拼闭标签正则；blockRe 靠 \1 做反引用。
 */
const BLOCK_TAG = '(tool_calls|function_calls|calls)';

function blockRe(): RegExp {
  // 反引用 \1 保证起止包裹名一致（calls 配 calls）。
  // 2026-09-10（fix/dsml-tolerant-closes）：闭标签的命名空间**可选**——现场日志里模型开标签带
  // ｜DSML｜、闭标签却是普通的 </tool_calls> / </invoke> / </parameter>。
  // 2026-09-10（fix/dsml-namespace-optional）：开标签的命名空间同样可选。
  // 2026-09-10（fix/dsml-bar-run）：竖线个数放宽成 1+，并容忍其后的空白。
  return new RegExp(`<${NS}${BLOCK_TAG}>([\\s\\S]*?)</${NS}\\1>`, 'gi');
}
function blockStartRe(): RegExp {
  return new RegExp(`<${NS}${BLOCK_TAG}>`, 'i');
}
/**
 * DSML 命名空间标记本体：`<` 或 `</` + 1+ 竖线 + DSML + 1+ 竖线。**只用于检测**（解析走上面的严格正则）。
 * 检测必须宽于解析：现场字节的竖线个数、其后空白、乃至标签名都会漂移，检测一旦漏掉，
 * DSML 就会被当普通散文静默透传（v0.1.100 开标签、v0.2.4 闭标签现场都是这么漏的）。
 * `call` + `s` 这类普通英文词不会出现 `<`（或 `</`）+ 竖线 + `DSML` 的组合，所以不会误判。
 */
function dsmlMarkerRe(): RegExp {
  // 2026-09-15（fix/dsml-close-tag-detect）：`</?` —— 闭标签形态（`</｜｜DSML｜｜ …>`，
  // `<` 与竖线之间有 `/`）旧模式全部脱靶（详见文件头偏差 5）。
  return new RegExp(`</?${BARS}DSML${BARS}`, 'i');
}
function invokeRe(): RegExp {
  return new RegExp(`<${NS}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${NS}invoke>`, 'gi');
}
function paramRe(): RegExp {
  // 2026-09-11（fix/review-r1）：string 属性放宽为可选——现场形态持续漂移，缺属性时旧正则整段
  // 匹配不到，parameter 被静默丢弃（调用以 {} 发出，下游锁目录/文件）。缺省按 "false"（schema 驱动）：
  // 声明为 string 的 schema 行为等价于 string="true"，声明为 number/int 的能转成正确类型。
  return new RegExp(`<${NS}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${NS}parameter>`, 'gi');
}
/** 无命名空间的裸工具标记（`<invoke name=` / `<parameter name=`），命名空间可选。 */
function invokeMarkRe(): RegExp {
  // 2026-09-15（fix/dsml-close-tag-detect）：`</?` 与 dsmlMarkerRe 同理——闭标签残片
  // （如 `</｜DSML｜invoke name="X">`）也要能被检测认出。
  return new RegExp(`</?${NS}(?:invoke|parameter)\\s+name=`, 'i');
}
/** 文本是否含「工具调用」形状的标记（DSML 命名空间 或 裸 invoke/parameter）。 */
function isToolMarkup(text: string): boolean {
  return dsmlMarkerRe().test(text) || invokeMarkRe().test(text);
}

export interface DsmlParseResult { calls: ToolCall[]; content: string }

/** 定位第一个工具块开标签（`<` 可带漂移命名空间，标签名 tool_calls/function_calls/calls）。
 *  2026-09-15（fix/tool-call-recovery）：供 tool-pipeline 的结构化恢复层锚定块起点——
 *  判据与解析同源（blockStartRe），不在此处另立正则。 */
export function firstToolBlockOpen(text: string): { start: number; end: number } | null {
  const m = blockStartRe().exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** 非流式解析：返回结构化 tool_calls + 去掉块的文本；没有可解析调用时返回 null。 */
export function parseDsmlToolCalls(text: string, tools: ToolDef[] = []): DsmlParseResult | null {
  if (!text) return null;
  const spans: Array<{ start: number; end: number; body: string }> = [];
  for (const m of text.matchAll(blockRe())) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, body: m[2] ?? '' });
  }
  // 2026-09-11（fix/review-r1）：除已闭合块外，还要收拢「未闭合的工具块」——否则
  // 「闭合块 A + 截断块 B」会静默返回 calls=[A] 且 remainder 里残留 B 的 DSML 原文
  // （丢调用 + 把标记透传给下游，违反 spec §4.4「解析不出就 repair/400，绝不静默透传」）。
  // 判据用 isToolMarkup：正文里恰好提到裸 <tool_calls> 不算工具块，不吞正文。
  for (const m of text.matchAll(new RegExp(blockStartRe().source, 'gi'))) {
    const start = m.index ?? 0;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    // 2026-09-11（fix/review-r2 N4）：候选起点在某个已闭合 span **之前** 时，不能追加
    // [start, text.length) 的截断 span——两者会重叠，同一个 invoke 被解析两次（工具调用重复下发）。
    // 只看「该起点到下一个 span 起点」这一段：段内含工具标记 = 真截断块 → 整体 fail-closed
    // （交给 repair）；段内只是散文（正文提到裸 <tool_calls>）→ 跳过，不吞正文。
    const nextStart = spans.filter((s) => s.start > start).reduce((min, s) => Math.min(min, s.start), text.length);
    if (nextStart !== text.length) {
      if (isToolMarkup(text.slice(start, nextStart))) return null;
      continue;
    }
    const rest = text.slice(start);
    if (!isToolMarkup(rest)) continue;
    spans.push({ start, end: text.length, body: rest.slice(m[0].length) });
  }
  spans.sort((a, b) => a.start - b.start);
  if (!spans.length) {
    // 容错：只有起始标记、没有块闭标签（模型写完 invoke 就直接停/被截断），但必须真的是工具标记。
    const m = blockStartRe().exec(text);
    if (!m || !isToolMarkup(text.slice(m.index))) return null;
    spans.push({ start: m.index, end: text.length, body: text.slice(m.index + m[0].length) });
  }
  const calls: ToolCall[] = [];
  for (const span of spans) {
    const parsed = parseInvokes(span.body, tools);
    // 任一 span 解析不出 → 整体判失败（部分成功会静默丢调用；交给上层 repair/400）
    if (parsed === null) return null;
    calls.push(...parsed);
  }
  if (!calls.length) return null;
  // remainder：剥掉所有块、保留块外文本（本仓库语义，见文件头偏差 2）
  let content = '';
  let cursor = 0;
  for (const s of spans) { content += text.slice(cursor, s.start); cursor = s.end; }
  content += text.slice(cursor);
  return { calls, content };
}

/** 文本里是否存在 DSML 工具调用标记（给 hasToolTags 用：区分「没调工具」与「调了但解析失败」）。
 *  判据必须**宽于解析**：现场字节的竖线个数、其后空白、乃至标签名都会漂移（见文件头偏差 3/4）。
 *  检测一旦漏掉，DSML 就被当普通散文静默透传——v0.1.100 现场正是如此。 */
export function hasDsmlToolTags(text: string): boolean {
  return !!text && isToolMarkup(text);
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
  const unparsed: string[] = [];
  let pending = '';
  let open: { startText: string; endRe: RegExp } | null = null;
  let blockBody = '';

  /** 块无法归一化时：是工具标记 → 扣进 unparsed；只是正文提到 <tool_calls> → 原样透传。 */
  function discardOrPassThrough(raw: string): string {
    if (isToolMarkup(raw)) { unparsed.push(raw); return ''; }
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
          const hold = partialMarkerHold(pending);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          return out;
        }
        out += pending.slice(0, m.index);
        pending = pending.slice(m.index + m[0].length);
        open = { startText: m[0], endRe: new RegExp(`</${NS}${m[1]}>`, 'i') };
        blockBody = '';
        continue;
      }
      const em = open.endRe.exec(pending);
      if (!em) { blockBody += pending; pending = ''; return out; }
      blockBody += pending.slice(0, em.index);
      pending = pending.slice(em.index + em[0].length);
      const raw = open.startText + blockBody + em[0];
      const normalized = normalizeBlock(blockBody, tools);
      out += normalized ?? discardOrPassThrough(raw);
      open = null;
      blockBody = '';
    }
  }

  function flush(): string {
    if (!open) { const t = pending; pending = ''; return t; }
    // 2026-09-10（fix/dsml-tolerant-closes）：未闭合块先尝试归一化——模型常常写完 invoke
    // 就直接结束（不带块闭标签）。归一化仍失败时按 fail-closed 处理，不再原样吐出。
    const inner = blockBody + pending;
    const startText = open.startText;
    open = null; blockBody = ''; pending = '';
    return normalizeBlock(inner, tools) ?? discardOrPassThrough(startText + inner);
  }

  return { feed, flush, unparsed };
}

/**
 * 扣住「可能是起始标记前缀」的尾巴长度（返回 0 = 不需要扣）。
 * 2026-09-10（fix/dsml-bar-run）：不再用固定 token 表做前缀比对——现场竖线个数、其后空白、
 * 乃至标签名都会漂移，固定表必然漏。改成结构判定：从最后一个 `<` 起若只会出现
 * 竖线/空白/DSML/小写字母与下划线，就判为「可能是标记前缀」并扣住。
 * 只影响**延迟**，不会丢字：判错了下一段就补发出去。
 */
function partialMarkerHold(pending: string): number {
  const lt = pending.lastIndexOf('<');
  if (lt === -1) return 0;
  const tail = pending.slice(lt);
  if (tail.length > MAX_MARKER_LEN) return 0;   // 超长肯定不是标记前缀，不无限扣
  return /^<[|｜\sDSMLa-z_]*$/i.test(tail) ? tail.length : 0;
}

/** 起始标记的长度上限（`<` + 竖线 + `DSML` + 竖线 + 空格 + `function_calls` 约 27），限制前缀比较窗口。 */
const MAX_MARKER_LEN = 32;

// ——— internal ———

/** 把一个 DSML 块体解析成结构化调用；返回 null 表示块体里有无法完整解析的 invoke/parameter 标记。
 *  2026-09-11（fix/review-r1）：不再静默丢调用——开标记数量与成功解析数量必须一致。 */
function parseInvokes(body: string, tools: ToolDef[]): ToolCall[] | null {
  const matches = [...body.matchAll(invokeRe())];
  const loose = [...body.matchAll(new RegExp(`<${NS}invoke\\b`, 'gi'))].length;
  if (loose !== matches.length) return null;
  const calls: ToolCall[] = [];
  for (const m of matches) {
    const name = m[1] ?? '';
    const params = parseParamDict(m[2] ?? '');
    if (params === null) return null;
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
  if (!calls || !calls.length) return null;
  return `<tool_calls>\n${JSON.stringify(calls)}\n</tool_calls>`;
}

type ParamEntry = [name: string, value: string, stringAttr: 'true' | 'false'];

/** 解析 invoke 体内的 parameter；返回 null = 有 parameter 开标记没解出来（截断/形态漂移）。
 *  2026-09-11（fix/review-r1）：旧实现静默忽略未匹配的 parameter，参数被丢光后调用仍以 {} 发出。 */
function parseParamDict(invokeBody: string): ParamEntry[] | null {
  const out: ParamEntry[] = [];
  for (const m of invokeBody.matchAll(paramRe())) {
    out.push([m[1] ?? '', m[3] ?? '', ((m[2] ?? 'false').toLowerCase() === 'false' ? 'false' : 'true')]);
  }
  const loose = [...invokeBody.matchAll(new RegExp(`<${NS}parameter\\b`, 'gi'))].length;
  if (loose !== out.length) return null;
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
