import { describe, it, expect } from 'vitest';
import { eventToChunks, finalChunk, toAggregate, toolCallDeltaChunks } from '../../src/background/chunk-encoder';
import type { ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { ToolCall } from '../../src/shared/api-types';

const ctx = { id: 'chatcmpl-1', model: 'deepseek-chat', created: 1700000000 };

describe('eventToChunks', () => {
  it('maps think/content deltas', () => {
    const a = eventToChunks({ kind: 'think_delta', content: '思考' }, ctx);
    expect(a[0]!.choices[0]!.delta.reasoning_content).toBe('思考');
    const b = eventToChunks({ kind: 'content_delta', content: '答', finish_reason: 'stop' }, ctx);
    expect(b[0]!.choices[0]!.delta.content).toBe('答');
    expect(b[0]!.choices[0]!.finish_reason).toBe('stop');
  });
  it('emits no chunk for message_id events', () => {
    expect(eventToChunks({ kind: 'message_id', id: 42 }, ctx)).toEqual([]);
  });
  it('maps usage to a chunk carrying full counts', () => {
    const u = eventToChunks({ kind: 'usage', inputTokens: 10, outputTokens: 5 }, ctx);
    expect(u[0]!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});
describe('finalChunk', () => {
  it('emits terminal chunk with finish_reason and optional usage', () => {
    const f = finalChunk(ctx, 'stop');
    expect(f.choices[0]!.finish_reason).toBe('stop');
    expect(f.usage).toBeUndefined();
    const w = finalChunk(ctx, 'stop', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(w.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});
describe('toAggregate', () => {
  it('assembles non-stream response with honest usage', () => {
    const r = toAggregate(ctx, { content: 'c', reasoning: 'r', toolCalls: [], finishReason: 'stop', usage: undefined });
    expect(r.choices[0]!.message.content).toBe('c');
    expect(r.choices[0]!.message.reasoning_content).toBe('r');
    expect(r.usage).toBeUndefined();
  });
});

describe('toolCallDeltaChunks (OpenAI SSE 兼容拆分)', () => {
  it('空数组返回空', () => {
    expect(toolCallDeltaChunks(ctx, [])).toEqual([]);
  });

  it('每个 tool_call 拆为独立 chunk，第一个 chunk 同时设 role+content=null', () => {
    const calls: ToolCall[] = [
      { id: 'c1', type: 'function', function: { name: 'f1', arguments: '{"a":1}' } },
      { id: 'c2', type: 'function', function: { name: 'f2', arguments: '{"b":2}' } },
    ];
    const chunks = toolCallDeltaChunks(ctx, calls);
    expect(chunks).toHaveLength(2);
    // 第一个 chunk：role + content + tool_calls[0]
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    expect(chunks[0]!.choices[0]!.delta.content).toBeNull();
    expect(chunks[0]!.choices[0]!.delta.tool_calls).toEqual([{ index: 0, id: 'c1', type: 'function', function: { name: 'f1', arguments: '{"a":1}' } }]);
    // 第二个 chunk：只含 tool_calls[1]，不带 role/content
    expect(chunks[1]!.choices[0]!.delta.role).toBeUndefined();
    expect(chunks[1]!.choices[0]!.delta.content).toBeUndefined();
    expect(chunks[1]!.choices[0]!.delta.tool_calls).toEqual([{ index: 1, id: 'c2', type: 'function', function: { name: 'f2', arguments: '{"b":2}' } }]);
    // finish_reason 为 null，不会在本帧里结束（实际由 finalChunk 负责）
    expect(chunks[0]!.choices[0]!.finish_reason).toBeNull();
    expect(chunks[1]!.choices[0]!.finish_reason).toBeNull();
  });

  it('arguments 保持字符串化（JSON 字符串，不是对象）— brief §3 规则3', () => {
    const calls: ToolCall[] = [{ id: 'c', type: 'function', function: { name: 'Read', arguments: '{"path":"x.ino"}' } }];
    const chunks = toolCallDeltaChunks(ctx, calls);
    const arg = chunks[0]!.choices[0]!.delta.tool_calls![0]!.function!.arguments;
    expect(typeof arg).toBe('string');
    expect(JSON.parse(arg as string)).toEqual({ path: 'x.ino' });
  });
});
