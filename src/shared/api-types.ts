export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message {
  role: Role; content: string;
  tool_call_id?: string; name?: string;   // role='tool' 时
  tool_calls?: ToolCall[];                 // role='assistant' 时
}
export interface ToolDef { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }
/** OpenAI 兼容工具调用策略：
 *  - 'none'：不注入工具提示（不调用工具）
 *  - 'auto'（默认）：模型自主决定是否调用；不保证调用
 *  - 'required'：强制调用至少一个工具（prompt-engineered 强指令；模型可能不遵守）
 *  - { type: 'function', function: { name } }：仅可调用指定工具（spec §4.4） */
export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
export interface ChatCompletionUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export type FinishReason = 'stop' | 'tool_calls' | string;
export interface ChatCompletionChunk {
  id: string; object: 'chat.completion.chunk'; created: number; model: string;
  choices: [{ index: 0; delta: { role?: Role; content?: string; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: FinishReason | null }];
  usage?: ChatCompletionUsage;   // spec §4.5：末尾 usage 分块（仅 input/output 都可得时）
}
export interface ChatCompletion {
  id: string; object: 'chat.completion'; created: number; model: string;
  choices: [{ index: 0; message: { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: FinishReason }];
  usage?: ChatCompletionUsage;
}
export type ApiErrorCode = 'missing_api_key' | 'invalid_api_key' | 'invalid_request_error' | 'rate_limited' | 'provider_unavailable' | 'internal_error';
export interface ApiErrorBody { error: { message: string; type: string; code: ApiErrorCode } }
export interface ModelInfo { id: string; provider: string; description: string }
