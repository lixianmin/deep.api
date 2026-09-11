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

});
