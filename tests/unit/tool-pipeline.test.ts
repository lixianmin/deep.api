import { describe, it, expect } from 'vitest';
import { buildToolPrompt, parseToolCalls, hasToolTags } from '../../src/background/tool-pipeline';
import type { ToolDef } from '../../src/shared/api-types';

describe('buildToolPrompt', () => {
  const tools: ToolDef[] = [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];
  it('injects defs unless tool_choice none', () => {
    expect(buildToolPrompt(tools, 'auto').promptSuffix).toContain('f');
    expect(buildToolPrompt(tools, 'none').promptSuffix).toBe('');
    const specific = buildToolPrompt(tools, { type: 'function', function: { name: 'f' } });
    expect(specific.promptSuffix).toContain('f');
  });

  it('tool_choice required forces must-call instruction (v0.1.36)', () => {
    const r = buildToolPrompt(tools, 'required');
    expect(r.promptSuffix).toContain('必须调用至少一个工具');
    expect(r.promptSuffix).toContain('f');  // 工具定义仍然透传
  });

  // 2026-09-12（fix/no-announcement-without-tools，spec docs/superpowers/specs/2026-09-12-no-announcement-without-tools-design.md）：
  // spice trace #260/#275 现场——模型输出「Now I'll rewrite…」宣言体纯文本（零工具调用）干净收尾，
  // 下游 agent 停摆。协议层减噪：宣言必须同消息携带块；无块纯文本只允许总结/提问。
  it('auto 分支禁止无工具调用的行动宣言（fix/no-announcement-without-tools）', () => {
    const r = buildToolPrompt(tools, 'auto');
    expect(r.promptSuffix).toContain('宣言');
    expect(r.promptSuffix).toContain('<tool_calls>');
    expect(r.promptSuffix).toContain('最终总结');
  });
});

describe('parseToolCalls', () => {
  it('parses clean json array', () => {
    const text = ['先思考', '<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":1}"}}]</tool_calls>'].join('\n');
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0]!.function.name).toBe('f');
  });

  it('repairs arguments with valid JSON string after unescape', () => {
    const text = '<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"x\\":1,\\"y\\":2}"}}]</tool_calls>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });

  it('skips tags inside code fences', () => {
    const text = ['```', '<tool_calls>x</tool_calls>', '```', '<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]</tool_calls>'].join('\n');
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });

  it('returns null on garbage', () => {
    expect(parseToolCalls('plain text without any tags')).toBeNull();
  });

  it('supports multiple calls in one block', () => {
    const text = '<|tool_call_begin|>[{"id":"a","type":"function","function":{"name":"f1","arguments":"{}"}},{"id":"b","type":"function","function":{"name":"f2","arguments":"{}"}}]<|tool_call_end|>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(2);
  });


  // 2026-09-09（fix/dsml-toolcalls）：DeepSeek Vision（deepseek-v4-flash-vision-exp）不用 prompt
  // 教的 <tool_calls> 标签——它有自己的 DSML 格式（DeepSeek Markup Language），包裹用全角
  // 竖线 ｜（U+FF5C）不是 ASCII |。现场：<｜｜DSML｜｜tool_calls>{...}<｜｜DSML｜｜>，
  // end 标签不带 tool_calls 后缀。router tool-pipeline 原三种标签全不匹配 → 工具调用
  // 被当纯文本写进 mirror.content，spice 端不会真去执行工具。
  // 修：TOOL_TAGS + findBlocks 正则增 DSML（start 要求含 tool_calls 防 end 误匹配），
  // parseBlocks 容错 JSON 数组/多个紧贴对象/单对象。
  it('parses DSML-wrapped tool calls array (Vision 模型现场·数组形态)', () => {
    const text =
      '<｜｜DSML｜｜tool_calls>' +
      '[{"id":"1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"sketch.ino\\"}"}},' +
      '{"id":"2","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"diagram.json\\"}"}}]' +
      '<｜｜DSML｜｜>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(2);
    expect(r!.calls[0]!.function.name).toBe('Read');
    expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
    expect(JSON.parse(r!.calls[1]!.function.arguments)).toEqual({ path: 'diagram.json' });
    // 包裹标签必须从 remainder 中剩除（spice 端看到的是干净文本）。
    expect(r!.remainder).not.toContain('DSML');
    expect(r!.remainder).not.toContain('tool_calls>');
  });

  // 2026-09-09（fix/dsml-toolcalls）：Vision 也可能输出多个紧贴 JSON 对象而非数组
  // （用户实际 sseRaw 转写后看不出分隔），parseBlocks 容错：试数组 → 试单对象 → 尝试
  // 以对象为间隔切分为多个对象解析。
  it('parses DSML-wrapped concatenated objects (Vision 输出无包裹数组容错)', () => {
    const text =
      '<｜｜DSML｜｜tool_calls>' +
      '{"id":"1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a\\"}"}}' +
      '{"id":"2","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"b\\"}"}}' +
      '<｜｜DSML｜｜>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(2);
    expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'a' });
    expect(JSON.parse(r!.calls[1]!.function.arguments)).toEqual({ path: 'b' });
  });


  it('parses missing-< opening tag variant (model output deformation)', () => {
    const text = ['tool_calls>', '[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":1}"}}]', '</tool_calls>', '', '根据查询结果，北京明天晴。'].join('\n');
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0]!.function.name).toBe('f');
    expect(r!.remainder).toContain('根据查询结果');
  });

  it('parses bare JSON object (model outputs tool call JSON without wrapping, 2026-09)', () => {
    const inner = JSON.stringify({ city: '北京' });
    const text = JSON.stringify({ id: 'weather_001', type: 'function', function: { name: 'get_weather', arguments: inner } });
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0]!.function.name).toBe('get_weather');
    expect(r!.calls[0]!.function.arguments).toContain('北京');
    expect(r!.remainder).toBe('');
  });

  it('parses JSON inside code fences (model wraps in code block)', () => {
    const text = '\`\`\`json\n[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]\n\`\`\`';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0]!.function.name).toBe('f');
  });

  // 2026-09-10（fix/dsml-namespace-optional）：现场 replySample 里 DSML 命名空间被整体剥离。
  // parseToolCalls 的 findBlocks 能匹配上裸 <tool_calls>，但块体是 invoke 标记而非 JSON
  // → 原有三层 fallback 全失败 → 返回 null；hasToolTags 也判 false → router 走
  // 「模型没调工具，合法 stop」分支（不 repair、原文透传）。DSML 分支必须接住裸形态。
  describe('命名空间被剥离的 DSML（现场 replySample 形态）', () => {
    const READ = 'Read';
    const bare = (tag: string, attrs = ''): string => `<${tag}${attrs}>`;
    const FIELD =
      `${bare('tool_calls')}\n` +
      `${bare('invoke', ` name="${READ}"`)}\n` +
      `${bare('parameter', ' name="path" string="true"')}sketch.ino</parameter>\n` +
      `</invoke>\n` +
      `</tool_calls>`;

    it('hasToolTags 认裸形态（否则静默 stop，不 repair）', () => {
      expect(hasToolTags(FIELD)).toBe(true);
    });

    it('parseToolCalls 解析裸形态，remainder 为空', () => {
      const r = parseToolCalls(FIELD);
      expect(r).not.toBeNull();
      expect(r!.calls[0]!.function.name).toBe(READ);
      expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
      expect(r!.remainder).toBe('');
    });
  });

  // 2026-09-15（fix/dsml-close-tag-detect）：spice 现场——模型开**标准** <tool_calls>（prompt 教的
  // 形态）+ 块内合法 OpenAI JSON，收尾却是漂移形态的 DSML **闭标签**（</｜｜DSML｜｜ …）。
  // 检测正则只认开标签（< 后紧跟竖线，闭标签的 / 挡住全部模式）→ hasToolTags=false → router
  // 判「模型没调工具」→ 原文透传 + stop。检测层必须认出它（解析保持严格 → repair/400）。
  describe('标准开标签 + DSML 闭标签收尾（fix/dsml-close-tag-detect）', () => {
    // 与 dsml-parser.test.ts 同一 fixture（spice 现场字节，base64 内嵌理由同彼处）
    const HYBRID_WIRE_B64 =
      'SSdsbCBmaXJzdCBjaGVjayB0aGUga25vd2xlZGdlIGJhc2UgZm9yIGhvdyB0aGUgYnV6emVyIGlzIGRyaXZlbiBhbmQgd2hldGhlciBwdXNoYnV0dG9ucyBzdXBwb3J0IGEgY29sb3IgYXR0cmlidXRlLgoKPHRvb2xfY2FsbHM+Clt7ImlkIjoiZzEiLCJ0eXBlIjoiZnVuY3Rpb24iLCJmdW5jdGlvbiI6eyJuYW1lIjoiR3JlcCIsImFyZ3VtZW50cyI6IntcInBhdHRlcm5cIjpcImJ1enplcnx0b25lfG5vVG9uZVwiLFwicGF0aFwiOlwiZG9jcy9rbm93bGVkZ2UvcGFydHMubWRcIixcImlnbm9yZUNhc2VcIjp0cnVlLFwiY29udGV4dFwiOjJ9In19LHsiaWQiOiJnMiIsInR5cGUiOiJmdW5jdGlvbiIsImZ1bmN0aW9uIjp7Im5hbWUiOiJHcmVwIiwiYXJndW1lbnRzIjoie1wicGF0dGVyblwiOlwicHVzaGJ1dHRvbnxidXR0b25cIixcInBhdGhcIjpcImRvY3Mva25vd2xlZGdlL3BhcnRzLm1kXCIsXCJpZ25vcmVDYXNlXCI6dHJ1ZSxcImNvbnRleHRcIjoyfSJ9fSx7ImlkIjoiZzMiLCJ0eXBlIjoiZnVuY3Rpb24iLCJmdW5jdGlvbiI6eyJuYW1lIjoiR3JlcCIsImFyZ3VtZW50cyI6IntcInBhdHRlcm5cIjpcImNvbG9yXCIsXCJpZ25vcmVDYXNlXCI6dHJ1ZSxcImNvbnRleHRcIjoxfSJ9fV0KPC/vvZzvvZxEU01M772c772cIHBhcmFtZXRlcj4KPC/vvZzvvZxEU01M772c772cIGludm9rZT4KPC/vvZzvvZxEU01M772c772cIGNhbGxzPg==';
    const wire = Buffer.from(HYBRID_WIRE_B64, 'base64').toString('utf8');

    it('hasToolTags 认混合形态（否则 router 静默 stop、原文透传）', () => {
      expect(hasToolTags(wire)).toBe(true);
    });

    // 2026-09-15（fix/tool-call-recovery）：v0.2.5 时本用例断言 null（fail-closed 走 repair），
    // piano 现场证明 repair 不是漂移的可靠兑底（重问后再漂 → 400 断链），且块体人眼可读可验证
    // → 改为直接断言结构化恢复成功；fail-closed 语义保留给真正不可恢复的块体（见下方新 describe）。
    it('解析不出 → repair；结构化恢复落地后直接解出 3 个 Grep 调用', () => {
      const r = parseToolCalls(wire);
      expect(r).not.toBeNull();
      expect(r!.calls.map((c) => c.function.name)).toEqual(['Grep', 'Grep', 'Grep']);
      expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ pattern: 'buzzer|tone|noTone', path: 'docs/knowledge/parts.md', ignoreCase: true, context: 2 });
    });
  });

  // 2026-09-15（fix/tool-call-recovery）：v0.2.5 piano 现场证明 repair 不是漂移的可靠兑底——
  // 重问后模型再次漂移（第 6 形态：arguments 未按约定 stringify、内层引号未转义），400 收场、
  // agent 链断裂；而块体是人眼可读、可验证的（近乎）合法 OpenAI JSON。本组锁定「结构化恢复层」：
  // 工具块开标签锚定 + 块体平衡 JSON 提取（引号/转义感知）+ arguments 内联对象修复，
  // 全部通过严格校验才恢复；任何一步失败仍返回 null（fail-closed，走 repair/400 不变）。
  describe('块体结构化恢复：开标签锚定 + JSON 提取 + inline args 修复（fix/tool-call-recovery）', () => {
    // v0.2.5 piano 现场字节（spice 报告，base64 内嵌理由同上）
    const INCIDENT_WIRE_B64 =
      '5oiR5YWI55yL5LiA5LiL5b2T5YmN6aG555uu5paH5Lu277yM5LqG6Kej5p2/5a2Q5ZKM5qC85byP44CCCgo8dG9vbF9jYWxscz4KW3siaWQiOiIxIiwidHlwZSI6ImZ1bmN0aW9uIiwiZnVuY3Rpb24iOnsibmFtZSI6IlJlYWQiLCJhcmd1bWVudHMiOiJ7InBhdGgiOiJza2V0Y2guaW5vIn0ifX0seyJpZCI6IjIiLCJ0eXBlIjoiZnVuY3Rpb24iLCJmdW5jdGlvbiI6eyJuYW1lIjoiUmVhZCIsImFyZ3VtZW50cyI6InsicGF0aCI6ImRpYWdyYW0uanNvbiJ9In19LHsiaWQiOiIzIiwidHlwZSI6ImZ1bmN0aW9uIiwiZnVuY3Rpb24iOnsibmFtZSI6IlJlYWQiLCJhcmd1bWVudHMiOiJ7InBhdGgiOiJwcm9qZWN0Lmpzb24ifSJ9fV08L++9nO+9nERTTUzvvZzvvZwgcGFyYW1ldGVyPgo8L++9nO+9nERTTUzvvZzvvZwgaW52b2tlPgo8L++9nO+9nERTTUzvvZzvvZwgY2FsbHM+';
    const incident = Buffer.from(INCIDENT_WIRE_B64, 'base64').toString('utf8');

    it('piano 现场（inline args + 漂移闭标签）→ 恢复 3 个 Read，remainder = 前言', () => {
      const r = parseToolCalls(incident);
      expect(r).not.toBeNull();
      expect(r!.calls.map((c) => c.function.name)).toEqual(['Read', 'Read', 'Read']);
      expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'sketch.ino' });
      expect(JSON.parse(r!.calls[1]!.function.arguments)).toEqual({ path: 'diagram.json' });
      expect(JSON.parse(r!.calls[2]!.function.arguments)).toEqual({ path: 'project.json' });
      expect(r!.remainder).toBe('我先看一下当前项目文件，了解板子和格式。\n\n');
    });

    it('闭合标准块 + inline args（包裹正常、块体坏）→ 恢复', () => {
      const text = '<tool_calls>\n[{"id":"c1","type":"function","function":{"name":"Read","arguments":"{"path":"a.ino"}"}}]\n</tool_calls>';
      const r = parseToolCalls(text);
      expect(r).not.toBeNull();
      expect(r!.calls).toHaveLength(1);
      expect(JSON.parse(r!.calls[0]!.function.arguments)).toEqual({ path: 'a.ino' });
      expect(r!.remainder).toBe('');
    });

    it('块体合法 JSON 但不是工具调用 → null（fail-closed 走 repair）', () => {
      expect(parseToolCalls('前言\n<tool_calls>\n[{"a":1}]\n</｜｜DSML｜｜ calls>')).toBeNull();
    });

    it('块体无可提取 JSON / 括号不平衡 → null（fail-closed 走 repair）', () => {
      expect(parseToolCalls('前言\n<tool_calls>\n垃圾内容\n</｜｜DSML｜｜ calls>')).toBeNull();
      expect(parseToolCalls('前言\n<tool_calls>\n[{"id":"1","type":"function"')).toBeNull();
    });
  });

});
