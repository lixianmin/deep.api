import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, UploadFileResult, PollFileReadyOptions, PollFileReadyResult } from '../adapter';
import { completionPayload, baseHeaders, classify, MODELS, resolveModel } from './client';
import { getAuthStatus, DEEPSEEK_LOGIN_PAGE, DEEPSEEK_COOKIE_NAMES } from './auth';
import { completionEvents } from './sse-patch';

export interface AdapterDeps {
  getToken(): Promise<string | null>;
  fetchJson(path: string, headers: Record<string, string>, body: unknown): Promise<unknown>;
  /** 2026-09-09（feat/vision-multimodal）：原始 fetch（不 stringify body、不限定 JSON 响应）。
   *  用于 file upload（multipart/form-data）+ poll（GET）等不规则端点；见 spec §4。 */
  fetchRaw?(path: string, headers: Record<string, string>, init: { method?: string; body?: BodyInit | null }): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;
  fetchStream(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array> }>;
  pow: { getChallenge(ctx: ProviderContext, targetPath: string): Promise<unknown>; solve(challenge: unknown, ctx: ProviderContext): Promise<string> };
  now(): number;
}

const NO_PROGRESS_MS = 600_000;   // 10 分钟无进度断流（spec §4.5）
const FILE_UPLOAD_TARGET = '/api/v0/file/upload_file';   // pow target_path（绝对路径形式，服务端约定）
/** 2026-09-11（fix/review-r1）：poll 走 deps.fetchRaw，其契约与 uploadFile 一致——只接收相对路径
 *  （sw.ts 会拼 DEEPSEEK_API_BASE）。旧值 '/api/v0/file/fetch_files' 会拼成
 *  'https://chat.deepseek.com/api/v0/api/v0/file/fetch_files' → 404/SPA HTML → 轮询永远不成功，
 *  每张图白等 7.5s 且 FAILED 分支生产不可达（memory 架构决策 #4）。 */
const FILE_FETCH_PATH = '/file/fetch_files';
const DEFAULT_POLL_MAX = 10;
const DEFAULT_POLL_INTERVAL_MS = 2000;

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

    // 2026-09-09（feat/vision-multimodal）：spike #2 现场 user Chrome DevTools 抓包逆向。
    // 完整请求：POST /api/v0/file/upload_file · multipart/form-data field="file" · 必须
    // headers: x-ds-pow-response（pow target=upload_file）、x-file-size、x-model-type=vision、
    // x-thinking-enabled=1。响应：{code:0, data:{biz_code:0, biz_data:{id, filename, bytes, status}}}，
    // id 格式 `file-<UUID>`——作为 ref_file_ids 传入主 completion 请求。
    // SW 不能设 origin/referer/UA（forbidden headers）——期望服务端不校验，与 v0.1.76 completion 路径一致。
    async uploadFile(ctx, bytes, mime, filename): Promise<UploadFileResult> {
      const challenge = await deps.pow.getChallenge(ctx, FILE_UPLOAD_TARGET)
        .catch((e) => { throw classifyErr(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 503 })); });
      const powHeader = await deps.pow.solve(challenge, ctx);
      const boundary = `----WebKitFormBoundary${Date.now().toString(36)}`;
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
      const tail = `\r\n--${boundary}--\r\n`;
      const headBytes = new TextEncoder().encode(head);
      const tailBytes = new TextEncoder().encode(tail);
      const body = new Uint8Array(headBytes.length + bytes.length + tailBytes.length);
      body.set(headBytes, 0);
      body.set(bytes, headBytes.length);
      body.set(tailBytes, headBytes.length + bytes.length);
      const headers: Record<string, string> = {
        ...baseHeaders(ctx.token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Ds-Pow-Response': powHeader,
        'x-file-size': String(bytes.length),
        'x-model-type': 'vision',
        'x-thinking-enabled': '1',
        'x-client-version': '2.4.0',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-platform': 'web',
        'x-client-locale': 'en_US',
        'x-client-timezone-offset': '28800',
      };
      if (!deps.fetchRaw) throw classifyErr(new Error('uploadFile: deps.fetchRaw not implemented'));
      const resp = await deps.fetchRaw('/file/upload_file', headers, { method: 'POST', body });
      const r = (resp.status >= 400 ? await resp.json().catch(() => null) : await resp.json()) as any;
      if (resp.status >= 400 || r?.code !== 0 || r?.data?.biz_code !== 0) {
        const msg = r?.data?.biz_msg || r?.msg || `http ${resp.status}`;
        throw classifyErr(new Error(`Upload failed: ${msg}`));
      }
      const biz = r?.data?.biz_data;
      const id: string = biz?.id || biz?.file_id;
      if (!id) throw classifyErr(new Error('Upload failed: no file id in response'));
      return { id, filename: biz?.filename || filename, bytes: biz?.bytes || bytes.length, status: biz?.status || 'uploaded' };
    },

    // 2026-09-09（feat/vision-multimodal）：spike #2 现场 GET /api/v0/file/fetch_files?file_ids=...
    // （无 pow）。轮询直到 status ∈ ready 类 或 FAILED。默认 10×2s = 20s 超时。
    // 2026-09-11（fix/vision-poll-timeout 定稿）：超时**不抛错**、返回 {ready:false} 让 router
    // 记 warning 后继续发 completion——与参考实现 llmweb2api（client.ts pollFileReady 超时只 log
    // 后返回）一致；spec §3.3 旧写的 408 与参考不符，已同步修订。文件 FAILED 类仍显式抛错。
    // 注：曾把窗口缩到 5×1.5s 是为了绕开 poll URL 双前缀 bug（每次必超时）的体验，bug 已修（C5），
    // 窗口恢复参考实现口径。
    async pollFileReady(ctx, fileId, options) {
      const maxAttempts = options?.maxAttempts ?? DEFAULT_POLL_MAX;
      const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const url = `${FILE_FETCH_PATH}?file_ids=${encodeURIComponent(fileId)}`;
      const READY = new Set(['processed', 'ready', 'done', 'available', 'success', 'SUCCESS', 'completed', 'finished', 'uploaded']);
      const FAIL = new Set(['CONTENT_EMPTY', 'PARSE_FAILED', 'FAILED', 'ERROR']);
      if (!deps.fetchRaw) return { ready: true };   // 无 fetchRaw → 不等（不阻塞主流程）
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        let status = '';
        try {
          const resp = await deps.fetchRaw(url, baseHeaders(ctx.token), { method: 'GET' });
          const r = (resp.status >= 400 ? null : await resp.json()) as any;
          const files = r?.data?.biz_data?.files || r?.data?.files || [];
          status = files[0]?.status || '';
        } catch {
          continue;   // 单次网络抖动不算致命，继续轮询
        }
        if (READY.has(status)) return { ready: true };
        if (FAIL.has(status)) throw classifyErr(new Error(`File parse failed: ${fileId} status=${status}`));
      }
      console.warn(`[deep.api] pollFileReady timeout after ${maxAttempts} attempts (fileId=${fileId}) — proceeding anyway`);
      return { ready: false };
    },

    async *streamCompletion(ctx, req) {
      const model = { modelType: req.model.modelType, thinking: req.model.thinking };
      const headers = await withPowHeaders(ctx);
      const res = await fetchStreamSafe('/chat/completion', headers, completionPayload(req.session, req.prompt, model, req.overrides, req.refFileIds));
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
