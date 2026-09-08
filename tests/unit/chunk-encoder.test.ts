import { describe, it, expect } from 'vitest';
import { eventToChunks, finalChunk, toAggregate } from '../../src/background/chunk-encoder';
import type { ProviderStreamEvent } from '../../src/background/providers/adapter';

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
