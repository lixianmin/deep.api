import type { ApiErrorBody, ChatCompletion, ChatCompletionChunk, Message, ToolChoice, ToolDef } from './api-types';

export type BridgeMethod = 'chat.completions.create' | 'chat.completions.cancel' | 'models.list' | 'auth.sync' | 'auth.requested';
export interface BridgeParams { model: string; messages: Message[]; stream?: boolean; tools?: ToolDef[]; tool_choice?: ToolChoice; conversation_id?: string }
export type BridgeRequestMsg = { __deepApi: { id: number; method: BridgeMethod; params: unknown } };
export type BridgeResponseMsg =
  | { __deepApi: { id: number; kind: 'result'; value: unknown } }
  | { __deepApi: { id: number; kind: 'chunk'; chunk: ChatCompletionChunk } }
  | { __deepApi: { id: number; kind: 'done' } }
  | { __deepApi: { id: number; kind: 'error'; error: ApiErrorBody } };
export function isBridgeRequest(v: unknown): v is BridgeRequestMsg {
  if (typeof v !== 'object' || v === null) return false;
  const inner = (v as { __deepApi?: unknown }).__deepApi;
  if (typeof inner !== 'object' || inner === null) return false;
  const m = inner as { id?: unknown; method?: unknown; params?: unknown };
  return typeof m.id === 'number' && (m.method === 'chat.completions.create' || m.method === 'chat.completions.cancel' || m.method === 'models.list') && typeof m.params === 'object' && m.params !== null;
}
export class BridgeError extends Error {
  constructor(public error: ApiErrorBody, public status: number) { super(error.error.message); this.name = 'BridgeError'; }
}
export type { Message, ToolDef, ToolChoice } from './api-types';
export type { ApiErrorBody, ChatCompletion, ChatCompletionChunk } from './api-types';
