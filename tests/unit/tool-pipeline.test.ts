import { describe, it, expect } from 'vitest';
import { buildToolPrompt, parseToolCalls, TOOL_TAGS } from '../../src/background/tool-pipeline';
import type { ToolDef } from '../../src/shared/api-types';

describe('buildToolPrompt', () => {
  const tools: ToolDef[] = [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];
  it('injects defs unless tool_choice none', () => {
    expect(buildToolPrompt(tools, 'auto').promptSuffix).toContain('f');
    expect(buildToolPrompt(tools, 'none').promptSuffix).toBe('');
    const specific = buildToolPrompt(tools, { type: 'function', function: { name: 'f' } });
    expect(specific.promptSuffix).toContain('f');
  });
});

describe('parseToolCalls', () => {
  it('parses clean json array', () => {
    const text = '先思考\n<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":1}"}}]</tool_calls>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls[0]!.function.name).toBe('f');
  });

  it('repairs arguments with valid JSON string after unescape', () => {
    // arguments is a JSON string; ensure JSON.parse recovers after code-fence masking
    const text = '<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"x\\":1,\\"y\\":2}"}}]</tool_calls>';
    const r = parseToolCalls(text);
    expect(r).not.toBeNull();
    expect(r!.calls).toHaveLength(1);
  });

  it('skips tags inside code fences', () => {
    const text = '```\n<tool_calls>x</tool_calls>\n```\n<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]</tool_calls>';
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

  it('TOOL_TAGS exposes start/end pairs', () => {
    expect(TOOL_TAGS.starts).toEqual(expect.arrayContaining(['<|tool_call_begin|>', '<tool_calls>', '<tool_call>']));
    expect(TOOL_TAGS.ends).toEqual(expect.arrayContaining(['<|tool_call_end|>', '</tool_calls>', '</tool_call>']));
  });
});
