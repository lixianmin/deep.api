import type { ModelInfo } from '../../shared/api-types';

export type ProviderId = 'deepseek' | (string & {});
export interface ProviderContext { token: string; requestId: string }
export type AuthStatus = { state: 'logged_in' } | { state: 'logged_out' } | { state: 'expired'; message: string };
export interface ProviderSession { providerId: ProviderId; webSessionId: string; parentMessageId: number | string | null }
/** 2026-09-09（feat/vision-multimodal）：file upload 返回结构。spike #2 用户现场 biz_data.id 格式
 *  `file-<UUID>`（如 `file-5232d461-f059-...`）—— deep.api 用作 ref_file_ids 传入主请求。 */
export interface UploadFileResult {
  id: string;
  filename: string;
  bytes: number;
  status: string;
}
export interface PollFileReadyOptions { maxAttempts?: number; intervalMs?: number }
/** 2026-09-11（fix/vision-poll-timeout）：轮询结果回执——`ready: false` = 超时未确认就绪（非致命，
 *  调用方继续发 completion 但要记 warning 日志）；文件解析失败（FAILED 类）仍直接抛错。
 *  依据：参考实现 llmweb2api pollFileReady 超时只 log 后返回；spec 旧写的 408 与参考不符，已同步修订。 */
export interface PollFileReadyResult { ready: boolean }
/** 调用方可覆盖的模型层开关；undefined 表示沿用 ResolvedModel/LIMITS 默认。
 *  2026-09-11（feat/reasoning-search-alignment）：硬切到 pi-ai 对齐——`reasoning` 单字段
 *  替代旧 `thinking: bool | null` + `reasoning_effort: 'low'|'medium'|'high'|'max'` 两字段。
 *  spec §3.2 映射表。 */
export interface CompletionOverrides {
  /** Pi-ai-aligned thinking control. undefined = use model.thinking default; 'off' =
   *  strip thinking_enabled/reasoning_effort from request; other levels collapse to
   *  thinking_enabled=true with reasoning_effort mapped per spec §3.2. */
  reasoning?: import('../../shared/api-types').ReasoningLevel;
  /** Web search toggle (deep.api-specific). undefined → search_enabled=false. */
  search?: boolean;
}
export interface ProviderCompletion {
  session: ProviderSession;
  prompt: string;
  model: { modelType: 'default' | 'expert' | 'vision'; thinking: boolean };
  /** 2026-09-09（feat/vision-multimodal）：vision 模型 multipart 上传后拿到的 file_id 数组。
   *  adapter 透传到请求体的 ref_file_ids；flash/pro 不用。 */
  refFileIds?: string[];
  overrides?: CompletionOverrides;
  requestId: string;
}
export interface ResolvedModel { modelId: string; modelType: 'default' | 'expert' | 'vision'; supportsImages: boolean; thinking: boolean; limitChars: number }
export interface ProviderAdapter {
  readonly id: ProviderId;
  auth: {
    readonly loginPageUrl: string;
    readonly cookieDomain: string;
    readonly requiredCookies: string[];
    getAuthStatus(ctx: ProviderContext): Promise<AuthStatus>;
  };
  createSession(ctx: ProviderContext): Promise<ProviderSession>;
  deleteSession(ctx: ProviderContext, s: ProviderSession): Promise<void>;
  stopStream(ctx: ProviderContext, s: ProviderSession, messageId: number | string | null): Promise<void>;
  // 2026-09-09（feat/vision-multimodal）：spike #2 现场 chat.deepseek.com/api/v0/file/upload_file
  // + /file/fetch_files 逆向（用户 DevTools curl 验证）。adapter 提供 file upload + poll ready；
  // 详见 docs/superpowers/specs/2026-09-09-vision-multimodal-design.md §4。
  uploadFile?(ctx: ProviderContext, bytes: Uint8Array, mime: string, filename: string): Promise<UploadFileResult>;
  pollFileReady?(ctx: ProviderContext, fileId: string, options?: PollFileReadyOptions): Promise<PollFileReadyResult>;
  streamCompletion(ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent>;
  readonly models: ModelInfo[];
  resolveModel(modelId: string): ResolvedModel | null;
  isRateLimited(err: unknown): boolean;
  isAuthExpired(err: unknown): boolean;
  isUnavailable(err: unknown): boolean;
  capabilities: { thinking: boolean; functionCalling: 'none' | 'prompt-engineered' };
}
export type ProviderStreamEvent =
  | { kind: 'message_id'; id: number | string }
  | { kind: 'think_delta'; content: string }
  | { kind: 'content_delta'; content: string; finish_reason?: 'stop' | string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  // 2026-09-09（diag/pro-sse-paths）：SSE 流字节 + 路径集。仅一次、流末由 parser emit，Router
  // 接手后写入 log.sseBytes/ssePaths——判断 Pro 模型场景 B-1（只返 thinking）与 B-2（未识别 path）
  // 的唯一依据。rawSample：原始 SSE 文本前 600 字符（诊断 unknown 事件真实内容，v0.1.73）。
  | { kind: 'stream_stats'; bytes: number; paths: string[]; rawSample?: string };
export { ModelInfo };
