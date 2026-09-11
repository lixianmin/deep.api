/** 2026-09-11（feat/reasoning-search-alignment）：对齐 pi-ai `ModelThinkingLevel` 类型。
 *  单字段表达"开 + 力度"——`off` 状态由字段缺席实现（与 pi-ai `thinkingLevelMap: {off: null}` 一致）。
 *  调用方代码与 pi-ai `reasoning: ThinkingLevel` 选项字面相同。spec §3.2 映射表。 */
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
/** OpenAI 兼容 content block。文本 + 图片 URL（deep.api 仅 image_url）；image_url.url 支持
 *  data URL（base64）与 http(s) URL——上传后转 DeepSeek ref_file_ids。详情：docs/superpowers/specs/2026-09-09-vision-multimodal-design.md */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };
export interface Message {
  role: Role;
  /** string 是默认；ContentBlock[] 用于 vision multimodal 调用（仅 user role 且 model=vision 时）。 */
  content: string | ContentBlock[] | null;
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
/** OpenAI SSE 增量分块。每个分块可以是 content / reasoning_content / tool_calls 增量。
 *  tool_calls 增量支持 partial（仅含 index + 要追加的字段）：下游按 index 拼接完整 ToolCall。 */
export interface ChatCompletionChunk {
  id: string; object: 'chat.completion.chunk'; created: number; model: string;
  choices: [{ index: 0; delta: { role?: Role; content?: string | null; reasoning_content?: string; tool_calls?: Partial<ToolCall>[] }; finish_reason: FinishReason | null }];
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
