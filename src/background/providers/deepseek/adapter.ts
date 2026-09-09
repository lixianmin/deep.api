import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession } from '../adapter';
import { completionPayload, baseHeaders, classify, MODELS, resolveModel } from './client';
import { getAuthStatus, DEEPSEEK_LOGIN_PAGE, DEEPSEEK_COOKIE_NAMES } from './auth';
import { completionEvents } from './sse-patch';

export interface AdapterDeps {
  getToken(): Promise<string | null>;
  fetchJson(path: string, headers: Record<string, string>, body: unknown): Promise<unknown>;
  fetchStream(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array> }>;
  pow: { getChallenge(ctx: ProviderContext, targetPath: string): Promise<unknown>; solve(challenge: unknown, ctx: ProviderContext): Promise<string> };
  now(): number;
}

const NO_PROGRESS_MS = 600_000;   // 10 分钟无进度断流（spec §4.5）

export function createDeepSeekAdapter(deps: AdapterDeps): ProviderAdapter {
  const classifyErr = (e: unknown) => Object.assign(e instanceof Error ? e : new Error(JSON.stringify(e)), classify(e));

  async function withPowHeaders(ctx: ProviderContext): Promise<Record<string, string>> {
    const challenge = await deps.pow
      .getChallenge(ctx, '/api/v0/chat/completion')
      .catch((e) => { throw classifyErr(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 503 })); });
    const header = await deps.pow.solve(challenge, ctx);
    // 2026-09-09（fix/expert-client-version）：completion 请求必须带客户端版本指纹——
    // v0.1.75 sseRaw 现场：Pro（expert）返回 {"type":"error","content":"Update to the latest
    // version to use Expert.","finish_reason":"unsupported_client_by_model"}——服务端按
    // x-client-version 判客户端新旧，不带 = 旧客户端 = 拒用 Expert。
    // 2026-09-09 用户抓包（Chrome DevTools）真实验证：网页端带 x-client-version: 2.4.0、
    // x-client-bundle-id: com.deepseek.chat、x-client-locale: en_US、x-client-timezone-offset: 28800；
    // **不带** x-app-version；x-hif-dliq/x-hif-leim 是 Cloudflare Zaraz 分析 token（API 不要求）。
    // v0.1.77 曾用 zh_CN/locale——对 TIP「专家模式暂不支持搜索」中英文提示无直接证据（TIP 是
    // UI 提示，deep.api 已跳过不进模型输出）；对齐抓包用 en_US 与网页行为一致。
    // User-Agent/Referer 在浏览器 fetch 是 forbidden header 不能设（服务端不校验。
    return {
      ...baseHeaders(ctx.token),
      'X-Ds-Pow-Response': header,
      'x-client-version': '2.4.0',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-platform': 'web',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '28800',
    };
  }

  async function fetchJsonSafe(path: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    try { return await deps.fetchJson(path, headers, body); }
    catch (e) { throw classifyErr(e); }
  }
  async function fetchStreamSafe(path: string, headers: Record<string, string>, body: unknown) {
    try { return await deps.fetchStream(path, headers, body); }
    catch (e) { throw classifyErr(e); }
  }

  async function createSessionRaw(ctx: ProviderContext): Promise<ProviderSession> {
    const r: any = await fetchJsonSafe('/chat_session/create', baseHeaders(ctx.token), {});
    // 实测响应结构：{code:0, data:{biz_code:0, biz_data:{id:"<UUID>"}}}，id 在 data.biz_data.id
    const id: string | undefined = r?.data?.biz_data?.id ?? r?.data?.chat_session?.id ?? r?.data?.chat_session_id ?? r?.data?.biz_data?.chat_session_id;
    if (!id) throw classifyErr(new Error('create_session: id missing'));
    return { providerId: 'deepseek', webSessionId: id, parentMessageId: null };
  }
  async function deleteSessionRaw(ctx: ProviderContext, webSessionId: string): Promise<void> {
    await fetchJsonSafe('/chat_session/delete', baseHeaders(ctx.token), { chat_session_id: webSessionId });
  }

  return {
    id: 'deepseek',
    auth: {
      loginPageUrl: DEEPSEEK_LOGIN_PAGE,
      cookieDomain: 'chat.deepseek.com',     // 仅展示；sw.ts 中取 cookie 用 .chat.deepseek.com
      requiredCookies: [...DEEPSEEK_COOKIE_NAMES],
      getAuthStatus: (ctx) =>
        getAuthStatus(ctx, async (c) => {
          const s = await createSessionRaw(c);
          await deleteSessionRaw(c, s.webSessionId);
          return true;
        }),
    },

    async createSession(ctx) { return createSessionRaw(ctx); },
    async deleteSession(ctx, s) { await deleteSessionRaw(ctx, s.webSessionId); },
    async stopStream(ctx, s, messageId) {
      try {
        await fetchJsonSafe('/chat/stop_stream', baseHeaders(ctx.token), { chat_session_id: s.webSessionId, message_id: messageId });
      } catch { /* best-effort per spec */ }
    },

    async *streamCompletion(ctx, req) {
      const model = { modelType: req.model.modelType, thinking: req.model.thinking };
      const headers = await withPowHeaders(ctx);
      const res = await fetchStreamSafe('/chat/completion', headers, completionPayload(req.session, req.prompt, model, req.overrides));
      if (res.status !== 200) {
        throw classifyErr(Object.assign(new Error(`completion http ${res.status}`), { status: res.status, headers: res.headers }));
      }
      for await (const ev of completionEvents(res.body, NO_PROGRESS_MS, () => {})) yield ev;
    },

    models: MODELS,
    resolveModel,
    isRateLimited: (e) => classify(e).rateLimited,
    isAuthExpired: (e) => classify(e).authExpired,
    isUnavailable: (e) => classify(e).unavailable,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
  };
}
