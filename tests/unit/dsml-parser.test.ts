import { describe, it, expect } from 'vitest';
import {
  DSML_TOKEN,
  parseDsmlToolCalls,
  createDsmlStreamNormalizer,
  partialTagOverlap,
  hasDsmlToolTags,
} from '../../src/background/providers/deepseek/dsml-parser';
import type { ToolDef } from '../../src/shared/api-types';

// 2026-09-10（fix/dsml-tool-parser）：DSML 是 DeepSeek V4 的**原生**工具调用协议。
// Fixture 取自权威来源：
//  - vLLM v0.21.0 vllm/tool_parsers/deepseekv32_tool_parser.py docstring（多 invoke + 全 string 参数）
//  - DeepSeek 官方 V4 编码实现 deepseek_v4_encoding.py（string="true|false" 语义、闭合标签带前缀）
//  - @goodandready/dsh-dsml-artifact-guard（证实闭合标签是 </｜DSML｜parameter> 而非 </parameter>）
const T = DSML_TOKEN; // '｜DSML｜'

const READ_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'Read',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' }, limit: { type: 'number' } },
      },
    },
  },
];

describe('parseDsmlToolCalls：非流式解析（逐条对齐 vLLM extract_tool_calls）', () => {
  it('解析多 invoke、全 string 参数（vLLM docstring 样例）', () => {
    const text =
      `<${T}tool_calls>\n` +
      `<${T}invoke name="get_weather">\n` +
      `<${T}parameter name="location" string="true">杭州</${T}parameter>\n` +
      `<${T}parameter name="date" string="true">2024-01-16</${T}parameter>\n` +
      `</${T}invoke>\n` +
      `<${T}invoke name="get_weather">\n` +
      `<${T}parameter name="location" string="true">北京</${T}parameter>\n` +
      `<${T}parameter name="date" string="true">2024-01-16</${T}parameter>\n` +
      `</${T}invoke>\n` +
      `</${T}tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(2);
    expect(r!.calls[0]!.type).toBe('function');
    expect(r!.calls[0]!.function.name).toBe('get_weather');
    expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ location: '杭州', date: '2024-01-16' });
    expect(JSON.parse(r!.calls[1]!.function.arguments)).toEqual({ location: '北京', date: '2024-01-16' });
    expect(r!.calls[0]!.id).toMatch(/^call_[0-9a-f]+$/);
  });

  it('string="false" 按工具 schema 声明类型转换（number → 数字，不是字符串）', () => {
    const text =
      `<${T}tool_calls>\n` +
      `<${T}invoke name="Read">\n` +
      `<${T}parameter name="path" string="true">sketch.ino</${T}parameter>\n` +
      `<${T}parameter name="limit" string="false">200</${T}parameter>\n` +
      `</${T}invoke>\n` +
      `</${T}tool_calls>`;
    const r = parseDsmlToolCalls(text, READ_TOOLS)!;
    const args = JSON.parse(r.calls[0]!.function.arguments);
    expect(args.path).toBe('sketch.ino');
    expect(args.limit).toBe(200);
    expect(typeof args.limit).toBe('number');
  });

  it('无 schema 时 string="false" 保持字符串（对齐 vLLM 的 string 兜底）', () => {
    const text = `<${T}tool_calls><${T}invoke name="x"><${T}parameter name="n" string="false">42</${T}parameter></${T}invoke></${T}tool_calls>`;
    const r = parseDsmlToolCalls(text)!;
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ n: '42' });
  });

  it('兼容 V3.2 的 function_calls 包裹名', () => {
    const text = `<${T}function_calls><${T}invoke name="f"><${T}parameter name="a" string="true">1</${T}parameter></${T}invoke></${T}function_calls>`;
    const r = parseDsmlToolCalls(text)!;
    expect(r.calls[0]!.function.name).toBe('f');
  });

  it('块外文本作为 remainder 保留（本仓库 remainder 语义，非 vLLM 的截断语义）', () => {
    const text =
      `先读文件\n<${T}tool_calls><${T}invoke name="Read"><${T}parameter name="path" string="true">a</${T}parameter></${T}invoke></${T}tool_calls>\n读完了`;
    const r = parseDsmlToolCalls(text)!;
    expect(r.calls).toHaveLength(1);
    expect(r.content).toBe('先读文件\n\n读完了');
  });

  it('无 DSML 时返回 null（不误判纯文本）', () => {
    expect(parseDsmlToolCalls('普通回答，没有工具调用')).toBeNull();
    expect(parseDsmlToolCalls('')).toBeNull();
  });

  it('容错：小写 dsml + ASCII 竖线（模型漂移形态）', () => {
    const text = `<|dsml|tool_calls><|dsml|invoke name="Read"><|dsml|parameter name="path" string="true">sketch.ino</|dsml|parameter></|dsml|invoke></|dsml|tool_calls>`;
    const r = parseDsmlToolCalls(text)!;
    expect(r.calls[0]!.function.name).toBe('Read');
    expect(r.content).not.toContain('dsml');
  });

  it('参数被多余的 arguments 包装时解开（对齐 vLLM _repair_param_dict）', () => {
    const tools: ToolDef[] = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const text = `<${T}tool_calls><${T}invoke name="Read"><${T}parameter name="arguments" string="false">{"path":"sketch.ino"}</${T}parameter></${T}invoke></${T}tool_calls>`;
    const r = parseDsmlToolCalls(text, tools)!;
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
  });

  it('块内没有 invoke 时返回 null（不产空调用）', () => {
    expect(parseDsmlToolCalls(`<${T}tool_calls>这里没有 invoke</${T}tool_calls>`)).toBeNull();
  });
});

describe('partialTagOverlap：跨 delta 切断的标记探测（vLLM utils 同名函数）', () => {
  it('返回 text 后缀与 tag 前缀的最长匹配长度', () => {
    expect(partialTagOverlap('abc<｜DS', '<｜DSML｜tool_calls>')).toBe(4);
    expect(partialTagOverlap('abc', '<｜DSML｜tool_calls>')).toBe(0);
    expect(partialTagOverlap('<｜DSML｜tool_calls>', '<｜DSML｜tool_calls>')).toBe(0); // 完整标记不算 overlap
  });
});

describe('createDsmlStreamNormalizer：流式归一化（不泄漏 DSML，产出标准 <tool_calls> 文本）', () => {
  const start = `<${T}tool_calls>`;
  const body =
    `<${T}invoke name="Read">\n` +
    `<${T}parameter name="path" string="true">sketch.ino</${T}parameter>\n` +
    `</${T}invoke>`;
  const end = `</${T}tool_calls>`;

  function feedAll(deltas: string[]): string[] {
    const n = createDsmlStreamNormalizer(READ_TOOLS);
    const out: string[] = [];
    for (const d of deltas) {
      const t = n.feed(d);
      if (t) out.push(t);
    }
    const tail = n.flush();
    if (tail) out.push(tail);
    return out;
  }

  it('标记被切成三段也不泄漏：任何中间产出都不含 DSML 片段', () => {
    const out = feedAll(['好的我读一下\n', '<｜DSM', `L｜tool_calls>\n${body}\n`, end, '\n读完了']);
    for (const t of out) expect(t).not.toMatch(/dsml/i);
    const text = out.join('');
    expect(text).toContain('好的我读一下');
    expect(text).toContain('读完了');
    // 块被归一化成标准 <tool_calls> JSON（spice 端能直接解析的形态）
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const calls = JSON.parse(json);
    expect(calls[0].type).toBe('function');
    expect(calls[0].function.name).toBe('Read');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'sketch.ino' });
  });

  it('归一化文本能被现有 parseToolCalls 路径再解析（与既有工具链一致）', () => {
    const text = feedAll([start + body + end]).join('');
    expect(text).toContain('<tool_calls>');
    expect(text).toContain('</tool_calls>');
  });

  it('未闭合块 fail-closed：块外前置文本照常透传', () => {
    const out = feedAll(['前缀\n' + start + `<${T}invoke name="Read">`]);
    const text = out.join('');
    expect(text).toContain('前缀');
    // 2026-09-10（fix/dsml-no-silent-leak）：块内标记不再原样吐给使用方（旧行为 fail-open 泄漏）
    expect(text).not.toContain('name="');
  });

  it('普通文本逐段即时透传，不因等标记而整体扣住', () => {
    expect(feedAll(['第一段', '第二段']).join('')).toBe('第一段第二段');
  });

  it('纯文本里出现半个尖括号不会丢字', () => {
    expect(feedAll(['a < b', ' c']).join('')).toBe('a < b c');
  });
});

// 2026-09-10（fix/dsml-tolerant-closes）：用户 v0.1.96 现场日志——模型吐的是**混合形态**：
// 开标签带命名空间（<｜DSML｜invoke name="Read">、<｜DSML｜parameter ...>），
// 但闭标签是普通的 </parameter> / </invoke>（没有 ｜DSML｜ 前缀）。
// vLLM 的正则要求 </｜DSML｜invoke>，所以一条 invoke 都匹配不上 → 解析失败 → 流式路径
// 判「没调工具」→ finishReason=stop + DSML 原样漏出。闭标签的命名空间必须可选。
describe('现场混合形态：闭标签省略命名空间', () => {
  const T = DSML_TOKEN;
  const open = (tag: string, attrs = ''): string => `<${T}${tag}${attrs}>`;
  const oneCall =
    `${open('invoke', ' name="Read"')}\n` +
    `${open('parameter', ' name="path" string="true"')}sketch.ino</parameter>\n` +
    `</invoke>`;

  it('parseDsmlToolCalls：块闭标签带命名空间 + 内层闭标签不带', () => {
    const text = `${open('tool_calls')}\n${oneCall}\n</${T}tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
    expect(r!.calls[0]!.function.name).toBe('Read');
    expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
  });

  it('parseDsmlToolCalls：块闭标签也省略命名空间（</tool_calls>）', () => {
    const text = `${open('tool_calls')}\n${oneCall}\n</tool_calls>`;
    const r = parseDsmlToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });

  it('parseDsmlToolCalls：块完全没有闭标签（模型直接停）', () => {
    const r = parseDsmlToolCalls(`${open('tool_calls')}\n${oneCall}`);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });

  it('流式：闭标签省略命名空间 → content 归一化成标准 <tool_calls>，不泄漏 DSML', () => {
    const n = createDsmlStreamNormalizer();
    const out = [`<${T}tool_calls>\n`, `${oneCall}\n`, `</${T}tool_calls>`].map((d) => n.feed(d)).join('') + n.flush();
    expect(out).not.toMatch(/dsml/i);
    expect(out).toContain('<tool_calls>');
    const calls = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    expect(calls[0].function.name).toBe('Read');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'sketch.ino' });
  });

  it('流式：块未闭合也在 flush 时归一化（不再 fail-open 泄漏）', () => {
    const n = createDsmlStreamNormalizer();
    const out = n.feed(`<${T}tool_calls>\n${oneCall}`) + n.flush();
    expect(out).not.toMatch(/dsml/i);
    expect(out).toContain('<tool_calls>');
  });
});

// 2026-09-10（fix/dsml-namespace-optional）：用户 v0.1.97 现场 replySample——模型吐出的 DSML 块
// **命名空间被整体剥离**，只剩裸标签（同期 reasoningSample = "…Let me read the project files."）：
//   <tool_calls> / <invoke …> / <parameter …>sketch.ino</parameter>
// 三个 invoke 依次读 sketch.ino / diagram.json / libraries.txt。
// 旧实现三处正则都要求 ｜DSML｜（U+FF5C）在场，于是链式失败：
//   hasDsmlToolTags=false → parseDsmlToolCalls=null → hasToolTags=false
//   → router 判「模型没调工具，合法 stop」→ 原文当正文发给 spice + finishReason=stop（不 repair）。
// 权威实现（vLLM DeepSeekV32ToolParser 的 parameter/invoke 正则；llama.cpp
// common/parsers/deepseek.cpp 的 build_grammar）都把命名空间当字面量写死，但现场字节证明
// 它在传输里不可靠 → 命名空间必须整体可选。
describe('现场字节形态：命名空间被整体剥离（fix/dsml-namespace-optional）', () => {
  const READ = 'Read';
  const TAGS = ['tool_calls', 'invoke', 'parameter'] as const;
  /** 命名空间片段（传空串 = 现场裸形态）。 */
  const ns = (useNs: string): string => (useNs ? `${useNs}` : '');
  /** 组装 <invoke name=…>；工具名走变量，避免把名字写成字面量。 */
  const invoke = (useNs: string, name: string, path: string): string =>
    `<${ns(useNs)}${TAGS[1]} name="${name}">\n` +
    `<${ns(useNs)}${TAGS[2]} name="path" string="true">${path}</${ns(useNs)}${TAGS[2]}>\n` +
    `</${ns(useNs)}${TAGS[1]}>`;
  const block = (useNs: string, paths: string[]): string =>
    `<${ns(useNs)}${TAGS[0]}>\n` +
    paths.map((p) => invoke(useNs, READ, p)).join('\n') +
    `\n</${ns(useNs)}${TAGS[0]}>`;

  const PATHS = ['sketch.ino', 'diagram.json', 'libraries.txt'];
  const FIELD = block('', PATHS);       // 现场形态：命名空间被剥离
  const CANONICAL = block(T, PATHS);    // 规范形态：回归保护

  it('规范形态（带命名空间）仍照旧解析——回归保护', () => {
    const r = parseDsmlToolCalls(CANONICAL);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(3);
  });

  it('裸形态：三个 invoke 全部解析出来，块体全部剥掉', () => {
    const r = parseDsmlToolCalls(FIELD);
    expect(r).not.toBeNull();
    expect(r!.calls.map((c) => c.function.name)).toEqual([READ, READ, READ]);
    expect(r!.calls.map((c) => (JSON.parse(c.function.arguments) as { path: string }).path)).toEqual(PATHS);
    expect(r!.content).toBe('');
  });

  it('hasDsmlToolTags：裸形态必须算工具标记（否则 router 走静默 stop 分支）', () => {
    expect(hasDsmlToolTags(FIELD)).toBe(true);
    expect(hasDsmlToolTags(CANONICAL)).toBe(true);
  });

  it('不误判：我们自己的归一化产物（纯 JSON 块）不算 DSML 标记', () => {
    const normalized = `<tool_calls>\n[{"id":"c1","type":"function","function":{"name":"Read","arguments":"{}"}}]\n</tool_calls>`;
    expect(hasDsmlToolTags(normalized)).toBe(false);
  });

  it('不误判：正文里单纯提到 <tool_calls> 不算工具标记', () => {
    expect(hasDsmlToolTags('模型的输出需要包在 <tool_calls> 里')).toBe(false);
  });

  it('流式：裸形态逐字符喂入不泄漏标记，输出标准 <tool_calls> JSON', () => {
    const n = createDsmlStreamNormalizer(READ_TOOLS);
    let out = '';
    for (const ch of FIELD) out += n.feed(ch);
    out += n.flush();
    expect(out).not.toContain(` name="`);
    expect(out).not.toContain(T);
    expect(out).toContain('<tool_calls>');
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
    const calls = JSON.parse(json) as Array<{ function: { name: string } }>;
    expect(calls).toHaveLength(3);
    expect(n.unparsed).toEqual([]);
  });
});

// 2026-09-10（fix/dsml-no-silent-leak）：归一化失败不再 fail-open。
// 旧行为把解析不出的块原样吐给使用方（下游收到一段带标记的「文本回答」），且 router 流式路径
// 根本没有 repair 分支——只剩「静默 stop」。现改为 fail-closed：块扣住不吐，原文交 router
// 作 repair 输入；router 层 repair 一次，仍失败则 400（对齐非流式 finalize 的语义）。
describe('归一化失败必须 fail-closed（fix/dsml-no-silent-leak）', () => {
  const READ = 'Read';
  // 有工具标记但结构残缺（缺 </invoke>）→ 归一化必然失败，且不可能是普通散文
  const BROKEN = `<tool_calls>\n<invoke name="${READ}">\n<parameter name="path" string="true">broken.ino</parameter>\n</tool_calls>`;

  it('解析不出的工具标记块：feed/flush 不吐原文，原文落进 unparsed 供 repair 用', () => {
    const n = createDsmlStreamNormalizer();
    const out = n.feed(BROKEN) + n.flush();
    expect(out).not.toContain('broken.ino');
    expect(n.unparsed.join('')).toContain('broken.ino');
  });

  it('块外正文照常逐段透传，只有块本身被扣住', () => {
    const n = createDsmlStreamNormalizer();
    const out = n.feed('我读一下\n') + n.feed(BROKEN) + n.feed('\n读完了') + n.flush();
    expect(out).toContain('我读一下');
    expect(out).toContain('读完了');
    expect(out).not.toContain('broken.ino');
  });

  it('带命名空间的块即使块体是垃圾也不透传（确定是 DSML）', () => {
    const n = createDsmlStreamNormalizer();
    const out = n.feed(`<${T}tool_calls>\n垃圾内容\n</${T}tool_calls>`) + n.flush();
    expect(out).not.toContain('垃圾内容');
    expect(n.unparsed.join('')).toContain('垃圾内容');
  });

  it('例外：无命名空间且块体无工具标记 → 判为正文提到 <tool_calls>，原样透传', () => {
    const prose = '格式是 <tool_calls> 里放 JSON 数组';
    const n = createDsmlStreamNormalizer();
    const out = n.feed(prose) + n.flush();
    expect(out).toContain(prose);      // 不吞散文
    expect(n.unparsed).toEqual([]);    // 不误触发 repair
  });
});

// 2026-09-10（fix/dsml-bar-run）：v0.1.100 现场 rawB64 —— **经 base64 字节级对齐过**的真实 wire。
// 与 canonical 的差别（全部实测）：命名空间两侧各 2 个全角竖线（不是 1 个）；DSML 与标签名之间多一个空格；
// 包裹名是 `calls`（`tool_` 整段不在）。四个正则全部落空 → hasDsmlToolTags=false → hasToolTags=false
// → router 判「模型没调工具」→ 原文当正文透传 + finishReason=stop。v0.1.98/0.1.99 的容错都没盖住这个形态。
//
// fixture 以 base64 内嵌：DSML 标记的字面量在本仓库的协作链路（聊天/终端/工具解析）上会被吃掉，
// 只有 base64 能保证测试比对的是**真实字节**，而不是被腐蚀过的转写。
const FIELD_WIRE_B64 =
  'PO+9nO+9nERTTUzvvZzvvZwgY2FsbHM+CjzvvZzvvZxEU01M772c772cIGludm9rZSBuYW1lPSJSZWFkIj4KPO+9nO+9nERTTUzvvZzvvZwgcGFyYW1ldGVyIG5hbWU9InBhdGgiIHN0cmluZz0idHJ1ZSI+c2tldGNoLmlubzwv772c772cRFNNTO+9nO+9nCBwYXJhbWV0ZXI+Cjwv772c772cRFNNTO+9nO+9nCBpbnZva2U+Cjwv772c772cRFNNTO+9nO+9nCBjYWxscz4=';
const decodeB64 = (b: string): string => Buffer.from(b, 'base64').toString('utf8');

describe('现场字节形态：竖线数漂移 + 标签名缺前缀（fix/dsml-bar-run）', () => {
  const WIRE = decodeB64(FIELD_WIRE_B64);
  const B = '｜';
  const TAG = 'DSML';

  it('fixture 自证：24 个全角竖线，起始是「小于号 竖线 竖线 DSML 竖线 竖线 空格」', () => {
    expect([...WIRE].filter((c) => c === B)).toHaveLength(24);
    expect(WIRE.startsWith(`<${B}${B}${TAG}${B}${B} `)).toBe(true);
    expect(WIRE).toContain(`</${B}${B}${TAG}${B}${B} calls>`);
  });

  it('hasDsmlToolTags：必须认成工具标记（否则 router 走静默 stop 分支）', () => {
    expect(hasDsmlToolTags(WIRE)).toBe(true);
  });

  it('parseDsmlToolCalls：解析出 1 个调用 + path=sketch.ino', () => {
    const r = parseDsmlToolCalls(WIRE);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
    expect(r!.calls[0]!.function.name).toBe('Read');
    expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
  });

  it('流式：逐字符喂入不泄漏任何标记字节，产出标准 JSON', () => {
    const n = createDsmlStreamNormalizer(READ_TOOLS);
    let out = '';
    for (const ch of WIRE) out += n.feed(ch);
    out += n.flush();
    expect(out).not.toContain(B);
    expect(out).not.toContain(TAG);
    expect(out).not.toContain('parameter');
    expect(out).toContain('<tool_calls>');
    expect(n.unparsed).toEqual([]);
    const calls = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    expect(calls[0].function.name).toBe('Read');
  });

  it('回归：canonical（1 竖线/侧、tool_calls）仍然解析', () => {
    const T = DSML_TOKEN;
    const canon = `<${T}tool_calls>\n<${T}invoke name="Read">\n<${T}parameter name="path" string="true">sketch.ino</${T}parameter>\n</${T}invoke>\n</${T}tool_calls>`;
    const r = parseDsmlToolCalls(canon);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });
});
