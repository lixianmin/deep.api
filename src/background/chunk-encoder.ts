import type { ChatCompletion, ChatCompletionChunk, ChatCompletionUsage, FinishReason, ToolCall } from '../shared/api-types';
import type { ProviderStreamEvent } from './providers/adapter';

export interface StreamContext { id: string; model: string; created: number }
export interface StreamAggregate { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: FinishReason | null; usage?: ChatCompletionUsage }

export function eventToChunks(ev: ProviderStreamEvent, ctx: StreamContext): ChatCompletionChunk[] {
  const base = { id: ctx.id, object: 'chat.completion.chunk' as const, created: ctx.created, model: ctx.model };
  switch (ev.kind) {
    case 'think_delta':
      return [{ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.content }, finish_reason: null }] }];
    case 'content_delta':
      return [{ ...base, choices: [{ index: 0, delta: { content: ev.content }, finish_reason: (ev.finish_reason ?? null) as FinishReason | null }] }];
    case 'usage':
      return [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens } }];
    case 'message_id':
      return [];
  }
}
export function finalChunk(ctx: StreamContext, finishReason: FinishReason, usage?: ChatCompletionUsage): ChatCompletionChunk {
  return { id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}
export function toAggregate(ctx: StreamContext, agg: StreamAggregate): ChatCompletion {
  return {
    id: ctx.id, object: 'chat.completion', created: ctx.created, model: ctx.model,
    choices: [{ index: 0, message: { role: 'assistant', content: agg.content, ...(agg.reasoning ? { reasoning_content: agg.reasoning } : {}), ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}) }, finish_reason: agg.finishReason ?? 'stop' }],
    ...(agg.usage ? { usage: agg.usage } : {}),
  };
}
