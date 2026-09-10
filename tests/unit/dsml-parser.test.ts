import { describe, it, expect } from 'vitest';
import {
  DSML_TOKEN,
  parseDsmlToolCalls,
  createDsmlStreamNormalizer,
  partialTagOverlap,
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

  it('未闭合块 fail-open：不吞掉已有文本', () => {
    const out = feedAll(['前缀\n' + start + `<${T}invoke name="Read">`]);
    expect(out.join('')).toContain('前缀');
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
