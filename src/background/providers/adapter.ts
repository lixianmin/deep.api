import type { ModelInfo } from '../../shared/api-types';

export type ProviderId = 'deepseek' | (string & {});
export interface ProviderContext { token: string; requestId: string }
export type AuthStatus = { state: 'logged_in' } | { state: 'logged_out' } | { state: 'expired'; message: string };
export interface ProviderSession { providerId: ProviderId; webSessionId: string; parentMessageId: number | string | null }
export interface ProviderCompletion { session: ProviderSession; prompt: string; model: { modelType: 'default' | 'expert' | 'vision'; thinking: boolean }; requestId: string }
export interface ResolvedModel { modelId: string; modelType: 'default' | 'expert' | 'vision'; thinking: boolean; limitChars: number }
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
  | { kind: 'usage'; inputTokens: number; outputTokens: number };
export { ModelInfo };
