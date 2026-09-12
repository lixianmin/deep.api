import { BridgeError } from '../shared/protocol';
import type { ApiErrorCode, ChatCompletion, ChatCompletionChunk, Message, ModelInfo, ToolCall, ToolChoice, ToolDef } from '../shared/api-types';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderId, ProviderSession, ProviderStreamEvent, ResolvedModel } from './providers/adapter';
import { extractImageRefs, renderMessageContent } from './vision-pipeline';
import { labelToModelId } from '../content/models-sync';
import { SessionMapper, type ThreadEntry } from './session-mapper';
import { Queue, QueueTimeoutError } from './queue';
import { renderTranscript, renderTail, limitCharsFor } from './transcript-renderer';
import { eventToChunks, finalChunk, toAggregate, toolCallDeltaChunks, type StreamAggregate, type StreamContext } from './chunk-encoder';
import { buildToolPrompt, parseToolCalls, hasToolTags, type ToolContext } from './tool-pipeline';
import { createDsmlStreamNormalizer } from './providers/deepseek/dsml-parser';
import type { RingLog } from './log';
import { toB64 } from './log';

export interface RouterDeps {
  registry: Record<ProviderId, ProviderAdapter>;
  mapper: SessionMapper;
  queue: Queue;
  storage: { get(k: string): Promise<unknown | undefined> };
  log: RingLog;
  now(): number;
  // 2026-09-09（diag/version-stamp）：扩展版本号（来自 manifest.json），写入每条 log 自证构建。
  version: string;
}

function err(code: ApiErrorCode, message: string, status: number): BridgeError {
  return new BridgeError({ error: { message, type: 'api_error', code } }, status);
}

interface RunState {
  parentMessageId: number | string | null;
  repairDone: boolean;
  model: ResolvedModel;
  // 2026-09-10（diag/request-snapshot）：renderTranscript 拼出的出站 prompt 长度（不含 toolCtx 前缀
  // 之外的差异）——spice 的大 system prompt 与 demo 一句话请求的规模差直接可见。
  promptLen?: number;
  // 2026-09-09（diag/pro-sse-paths）：SSE 调试统计。stream 末事件里推入，与 done() 一起入 log。
  sseBytes?: number;
  ssePaths?: string[];
  sseRaw?: string;
  // 2026-09-11（diag/continue-thinking）：spike 期间临时诊断——定位 DeepSeek thinking 截断点。
  sseStatusValues?: string[];
  sseThinkingChars?: number;
  sseResponseChars?: number;
  sseRawTail?: string;
}

/** 2026-09-11（fix/review-r1）：会话字段在拿到队列锁后可能被「排队期间线程被推进」重决策改写，
 *  handle 作为可变引用贯穿 create()/encodeStream()/日志，确保两边看到的是最终事实。 */
interface RunHandle {
  stream: AsyncIterable<ProviderStreamEvent>;
  session: ProviderSession;
  convId: string;
  thread: ThreadEntry;
  run: RunState;
  action: 'rebuild' | 'incremental';
  threadFound: boolean;
  mirrorLen?: number;
  deletedOld: boolean;
}

const NO_PROGRESS_MS = 600_000;          // spec §4.5 兜底断流
// 2026-09-10（feat/log-b64-export）：base64 现场取证的字符上限。取 4000 的依据：现场 DSML 块（3 个
// invoke）约 380 字符，但多工具/长参数会成倍增长；旧的 replySample 上限 1200 曾把块截在闭合标签之前
// （定位不了形态，见 memory 的 200→1200 教训），故取证字段放宽到 4000（base64 约 5.3KB/条，
// 只落在带工具标记的日志条目上）。
const B64_SAMPLE_CHARS = 4000;
const REPAIR_INSTRUCTION = '你的上一条回复包含无法解析的工具调用 JSON。请重新输出，且只输出修复后的 JSON（不要解释、不要代码块）。';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isContentEvent(e: ProviderStreamEvent): boolean {
  return e.kind === 'content_delta' || e.kind === 'think_delta';   // 重试只发生在任何内容增量之前（spec §6.4）
}

export class Router {
  constructor(private d: RouterDeps) {}


  async models(): Promise<{ object: 'list'; data: ModelInfo[] }> {
    const hardcoded = Object.values(this.d.registry).flatMap(p => p.models);
    // 2026-09-10（feat/models-sync）：合并 chrome.storage.local 里的 modelsCatalog
    // （catalog 由 content script 写入 chrome.storage）——匹配 id 后用 catalog label 替换 description。
    // catalog 缺失 / 超 7 天 TTL → fall back 到 hardcoded。
    const catalog = await loadCatalogFromStorage(this.d.storage);
    if (!catalog) return { object: 'list', data: hardcoded };
    return {
      object: 'list',
      data: hardcoded.map((m) => {
        // 2026-09-11（fix/review-r1）：catalog 可能被外部写入含 null/非对象的元素，
        // 直接读 o.label 会 TypeError 把 models.list 打成 500；逐元素校验形状。
        const label = catalog.models.find((o) => o && typeof o.label === 'string' && labelToModelId(o.label) === m.id)?.label;
        return { ...m, description: label ?? m.description };
      }),
    };
  }

  async create(token: string, rawParams: unknown): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> {
    const p = rawParams as Record<string, any>;
    const started = this.d.now();
    const modelId = p.model as string;
    const provider = this.resolve(modelId);
    const resolved = provider.resolveModel(modelId)!;
    const messages = p.messages as Message[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) throw err('invalid_request_error', 'messages array required', 400);
    const ctx = { token, requestId: `req-${started}-${Math.random().toString(36).slice(2, 8)}` };
    // 2026-09-11（fix/vision-poll-timeout）：图片轮询超时是非致命警告，随请求日志一起给操作员看
    // （LogEntry.warnings）；不阻断 completion。
    const imageWarnings: string[] = [];
    // 2026-09-10（fix/sw-vision-error）：vision pipeline（uploadFile / pollFileReady / fetch / atob）
    // 任何拋错都会被 SW 端作为 unhandledrejection 吞掉（chrome MV3 SW 不自动 console.error
    // unhandledrejection）。外层包 try/catch + 写 log（ok:false + error message）保证错误不静默：
    // 1) Debug Log tab 有记录  2) BridgeError 透传到 SW line 280 catch 发 kind:'error' 给 bridge。
    try {
      // 2026-09-09（feat/vision-multimodal）：原 v0.1.66 拒绝 array content；现在为支持图片的模型
      // 放开——接受 image_url 块，走 vision-pipeline 上传转 ref_file_ids。
      // 2026-09-10（fix/vision-model-type）：判断依据从 modelType==='vision' 改为独立
      // supportsImages——wire model_type 要发 default（避免 vision 变体的 DSML 工具调用格式）。
      const refFileIds: string[] = [];
      if (resolved.supportsImages && provider.uploadFile && provider.pollFileReady) {
        // 抽所有 user message 的 image_url，按出现顺序上传
        let imgIdx = 0;
        for (let i = 0; i < messages.length; i++) {
          const refs = extractImageRefs(messages[i]!);
          for (const ref of refs) {
            let bytes: Uint8Array;
            let mime: string;
            if (ref.isDataUrl) {
              const b64 = ref.url.split(',')[1] ?? '';
              bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              mime = ref.mimeType || 'image/png';
            } else {
              const r = await fetch(ref.url);
              if (!r.ok) throw err('invalid_request_error', `image_url download failed: ${ref.url} (http ${r.status})`, 400);
              const ab = await r.arrayBuffer();
              bytes = new Uint8Array(ab);
              mime = r.headers.get('content-type')?.split(';')[0]?.trim() || ref.mimeType || 'image/png';
            }
            const filename = `img${imgIdx}.${(mime.split('/')[1] || 'png')}`;
            imgIdx++;
            const up = await provider.uploadFile(ctx, bytes, mime, filename);
            // 2026-09-11（fix/vision-poll-timeout）：不传 options——用 adapter 默认窗口 10×2s=20s
            // （对齐参考实现；之前缩到 5×1.5s 是为绕开 poll URL 双前缀 bug，bug 已修）。
            // 超时（ready:false）不报错：继续发 completion（带 ref_file_ids），但记 warning 日志。
            const verdict = await provider.pollFileReady(ctx, up.id);
            if (verdict && verdict.ready === false) {
              imageWarnings.push(`图片 ${up.id} 轮询超时未确认就绪，已带 ref_file_ids 继续发送（模型可能看不到图）`);
            }
            refFileIds.push(up.id);
          }
        }
      } else {
        // 不支持图片的模型：array content 含 image_url → 400（保留 v0.1.66 拒绝）
        for (let i = 0; i < messages.length; i++) {
          const refs = extractImageRefs(messages[i]!);
          if (refs.length > 0) {
            throw err('invalid_request_error', `messages[${i}] 含 image_url 但模型 ${resolved.modelId} 不支持图片输入`, 400);
          }
        }
      }
      // 成功路径：把 refFileIds 赋给外层 closure 供后续 req 用
      (ctx as { refFileIds?: string[] }).refFileIds = refFileIds;
    } catch (e) {
      // 任何 vision pipeline 错误 → 写 log + 拋 BridgeError（不静默）
      const msg = (e instanceof BridgeError) ? e.error.error.message : (e instanceof Error ? `${e.message}` : String(e));
      this.d.log.push({
        at: this.d.now(), provider: provider.id, model: modelId, ok: false, ms: this.d.now() - started, error: msg, version: this.d.version,
        finishReason: undefined, parentMessageId: null,
        replySample: undefined, reasoningSample: undefined, sseBytes: undefined, ssePaths: undefined, sseRaw: undefined,
        sseStatusValues: undefined, sseThinkingChars: undefined, sseResponseChars: undefined, sseRawTail: undefined,
        replyB64: undefined, rawB64: undefined, sseRawB64: undefined,
        messagesFull: JSON.stringify(messages),
        mirrorFull: undefined,
      });
      if (e instanceof BridgeError) throw e;
      // 2026-09-11（fix/vision-poll-timeout）：错误分类。可重试类（限流/登过期/WAF/网络）走统一映射；
      // 其余（上传被服务端拒绝、文件 FAILED、data URL 非法等）是**请求侧问题**，按 spec §3.3
      // 映射 400 invalid_request_error——旧实现一律压成 502 provider_unavailable，调用方会误以为可重试。
      const mapped = mapErrStatic(e, this.d.registry);
      const code = mapped.error.error.code;
      if (code === 'internal_error') {
        throw err('invalid_request_error', `vision pipeline failed: ${msg}`, 400);
      }
      // 保留上游错误原文（否则 upload 401 会被映射成泛化的「登录已过期」，定位不到是上传失败）。
      throw err(code, `vision pipeline failed: ${msg}`, mapped.status);
    }
    const refFileIds: string[] = (ctx as { refFileIds?: string[] }).refFileIds ?? [];
    // 2026-09-09（feat/vision-multimodal）：array content → 渲染成 prompt 字符串 + 标记有图位置。
    // 不修改原 messages（mirror 要存原 array 形态），复制一份 string 版给 renderTranscript/renderTail。
    const stringMessages: Message[] = messages.map((m) => ({
      ...m,
      content: typeof m.content === 'string' || m.content === null ? m.content : renderMessageContent(m),
    }));

    const toolCtx = buildToolPrompt((p.tools as ToolDef[] | undefined) ?? [], (p.tool_choice as ToolChoice | undefined) ?? 'auto');
    // 2026-09-11（feat/reasoning-search-alignment）：调用方可覆盖 reasoning/search；
    // reasoning 对齐 pi-ai ModelThinkingLevel（'off' | 'minimal' | ... | 'max'），
    // search 是 deep.api 独家保留字段。undefined 字段被下游忽略。
    const overrides = {
      reasoning: (p.reasoning ?? undefined) as import('../shared/api-types').ReasoningLevel | undefined,
      search: (p.search ?? undefined) as boolean | undefined,
    };
    const conversationId = p.conversation_id as string | undefined;
    // 2026-09-09 诊断字段（v0.1.50 落地）：在 handle 构造前先比一次，看看是不是 thread 找不到 / mirror 不匹配。
    // 给 popup 日志区提供 decision.action / threadFound / deletedOld 等现场信息。
    // 2026-09-09（fix/model-switch-rebuild）：decide 同时传 modelType，让 mapper 能 detect
    // 同 cid 中途切模型的情况并返回 rebuild（避免复用旧 model 的 webSessionId + parent_message_id 链）。
    const preDecide = this.d.mapper.decide(provider.id, messages, conversationId, resolved.modelType);
    const threadFound = preDecide.action !== 'rebuild' || preDecide.existing !== null;
    const mirrorLen = preDecide.action === 'incremental' ? preDecide.thread.mirror.length
      : preDecide.action === 'rebuild' && preDecide.existing ? preDecide.existing.mirror.length
      : undefined;
    // 2026-09-09（fix/mirror-content）：mirror 匹配失败时定位第一个不同点——popup 日志里
    // 用 `diff@${idx}` 提示用户“修正后的 messages 和 mapper 里 mirror 从第几条开始不一样”。
    const firstDiffIdx = threadFound
      ? (() => {
        const mirror: Message[] = preDecide.action === 'incremental' ? preDecide.thread.mirror
          : preDecide.action === 'rebuild' && preDecide.existing ? preDecide.existing.mirror : [];
        for (let i = 0; i < Math.min(mirror.length, messages.length); i++) {
          const a = mirror[i]!; const b = messages[i]!;
          if (a.role !== b.role || (a.content ?? '') !== (b.content ?? '')
            || JSON.stringify(a.tool_calls ?? null) !== JSON.stringify(b.tool_calls ?? null)) {
            return i;
          }
        }
        return mirror.length;
      })()
      : undefined;
    const handle = await this.runCompletion(provider, resolved, messages, stringMessages, toolCtx, conversationId, ctx, overrides, refFileIds);
    // 2026-09-10（diag/request-snapshot）：出站参数快照——两条路径共用本函数，差异只可能在输入侧
    // （tools 集合 / overrides / prompt 长度）。记下来用户就能拿 demo 与 spice 两条日志直接 diff。
    // 2026-09-11（fix/review-r1）：改为在 done() 里现算——handle 的会话/promptLen 可能被
    // 「拿锁后重决策」改写，预先冻结会把旧 promptLen / 旧 webSessionId 写进日志。
    const buildRequestFull = () => JSON.stringify({
      modelType: resolved.modelType,
      thinking: resolved.thinking,
      reasoningOverride: overrides.reasoning,
      search: overrides.search,
      toolChoice: p.tool_choice ?? 'auto',
      tools: ((p.tools as ToolDef[] | undefined) ?? []).map((t) => t.function?.name),
      refFileIds: refFileIds.length,
      promptLen: handle.run.promptLen,
    });
    const buildDiag = () => ({
      cid: handle.convId, msgsLen: messages.length, action: handle.action,
      threadFound: handle.threadFound, mirrorLen: handle.mirrorLen,
      deletedOld: handle.deletedOld,
      webSessionId: handle.session.webSessionId,
    });
    const done = (ok: boolean, ms: number, error?: string, extra?: { finishReason?: string; parentMessageId?: string | number | null; replySample?: string; rawSample?: string; reasoningSample?: string; sseBytes?: number; ssePaths?: string[]; sseRaw?: string; sseStatusValues?: string[]; sseThinkingChars?: number; sseResponseChars?: number; sseRawTail?: string }) =>
      this.d.log.push({
        at: this.d.now(), provider: provider.id, model: modelId, ok, ms, error, version: this.d.version, ...buildDiag(),
        finishReason: extra?.finishReason, parentMessageId: extra?.parentMessageId,
        replySample: extra?.replySample,
        reasoningSample: extra?.reasoningSample,
        sseBytes: extra?.sseBytes,
        ssePaths: extra?.ssePaths,
        sseRaw: extra?.sseRaw,
        // 2026-09-11（diag/continue-thinking）：spike 期间诊断字段。
        sseStatusValues: extra?.sseStatusValues,
        sseThinkingChars: extra?.sseThinkingChars,
        sseResponseChars: extra?.sseResponseChars,
        sseRawTail: extra?.sseRawTail,
        warnings: imageWarnings.length ? [...imageWarnings] : undefined,
        // 2026-09-10（feat/log-b64-export）：同一份现场字符串再给 base64 版本——DSML 标记（｜DSML｜）
        // 会在聊天/终端粘贴链上被吃掉，只有 base64 能把字节原样送出来。
        replyB64: toB64(extra?.replySample),
        rawB64: toB64(extra?.rawSample),
        sseRawB64: toB64(extra?.sseRaw),
        sseRawTailB64: toB64(extra?.sseRawTail),
        firstDiffIdx,
        requestFull: buildRequestFull(),
        messagesFull: JSON.stringify(messages),
        mirrorFull: threadFound
          ? JSON.stringify(preDecide.action === 'incremental' ? preDecide.thread.mirror
            : preDecide.action === 'rebuild' && preDecide.existing ? preDecide.existing.mirror : [])
          : undefined,
      });
    if (p.stream === true) return this.encodeStream(provider, handle, ctx, modelId, started, messages, toolCtx, done);
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    // 2026-09-10（feat/log-b64-export）：finalize 会改写 agg.content（剥掉工具块后的 remainder），
    // 先留住「解析前」的模型原文，供 rawB64 做字节级取证。
    let rawSample = '';
    try {
      for await (const ev of handle.stream) this.consumeEvent(ev, agg, handle.run);
      rawSample = agg.content.slice(0, B64_SAMPLE_CHARS);
      await this.finalize(provider, handle, messages, agg, ctx, toolCtx);
    } catch (e) {
      // 2026-09-10：失败路径也要带现场样本——parsing 失败（400）恰恰是最需要字节证据的场景。
      done(false, this.d.now() - started, (e as Error).message, { replySample: agg.content.slice(0, 1200), rawSample, sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw, sseStatusValues: handle.run.sseStatusValues, sseThinkingChars: handle.run.sseThinkingChars, sseResponseChars: handle.run.sseResponseChars, sseRawTail: handle.run.sseRawTail });
      // 2026-09-11（fix/review-r1）：失败路径必须销毁线程（spec §4.3「线程标记失败并销毁」）。
      // 旧实现只 done(false) 就抛错，incremental 路径 markBusy 后永远没有 commit —— 该 auto
      // thread 永久 busy，decide 会跳过它，直到 TTL/LRU 才被清；mirror 也永远停在旧位置。
      // 2026-09-11（fix/review-r2 N2）：队列超时说明本请求从未进入会话（会话属于前面的在途请求），
      // 不得销毁；另带 requestId token，只销毁本请求持有的 busy 线程。
      if (!(e instanceof QueueTimeoutError)) await this.d.mapper.fail(provider.id, handle.convId, ctx.requestId);
      throw this.mapErr(e);
    }
    done(true, this.d.now() - started, undefined, { finishReason: agg.finishReason ?? 'stop', parentMessageId: handle.run.parentMessageId, replySample: agg.content.slice(0, 1200), rawSample, reasoningSample: agg.reasoning.slice(0, 200), sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw, sseStatusValues: handle.run.sseStatusValues, sseThinkingChars: handle.run.sseThinkingChars, sseResponseChars: handle.run.sseResponseChars, sseRawTail: handle.run.sseRawTail });
    return toAggregate({ id: `chatcmpl-${ctx.requestId}`, model: modelId, created: Math.floor(started / 1000) }, agg);
  }

  private resolve(model: string): ProviderAdapter {
    for (const a of Object.values(this.d.registry)) if (a.resolveModel(model)) return a;
    throw err('invalid_request_error', `unknown model: ${model}`, 400);
  }

  private async runCompletion(
    provider: ProviderAdapter, resolved: ResolvedModel, messages: Message[], stringMessages: Message[], toolCtx: ToolContext,
    conversationId: string | undefined, ctx: ProviderContext,
    overrides?: { thinking?: boolean | null; search?: boolean; reasoningEffort?: 'low' | 'medium' | 'high' | 'max' },
    refFileIds: string[] = [],
  ): Promise<RunHandle> {
    const pid = provider.id;
    const decision = this.d.mapper.decide(pid, messages, conversationId, resolved.modelType);
    if (decision.action === 'error') throw err(decision.code, decision.message, 400);
    let session: ProviderSession; let convId: string; let thread: ThreadEntry; let prompt: string;
    if (decision.action === 'rebuild') {
      if (decision.existing) {
        try { await provider.deleteSession(ctx, { providerId: pid, webSessionId: decision.existing.webSessionId, parentMessageId: decision.existing.parentMessageId }); } catch { /* best effort per spec */ }
      }
      const s = await provider.createSession(ctx);
      // 优先级：existing 保留同名 cid > 用户传的 cid（named 首次请求） > auto 顺序号
      convId = decision.existing?.conversationId ?? conversationId ?? this.d.mapper.nextAutoConversationId();
      // 2026-09-09（fix/model-switch-rebuild）：rebuild 时 modelType 一定传（resolved.modelType），
      // 让 mapper 跟踪该 cid 当前绑定的模型。下一轮同 cid 同模型→ incremental；下一轮同 cid 换模型→ rebuild。
      thread = this.d.mapper.register(pid, convId, s.webSessionId, messages, resolved.modelType);
      session = { providerId: pid, webSessionId: s.webSessionId, parentMessageId: null };
      prompt = renderTranscript(stringMessages).ok
        ? (renderTranscript(stringMessages) as { ok: true; prompt: string }).prompt + toolCtx.promptSuffix
        : '';   // 超限在下方统一检查
    } else {
      thread = decision.thread; convId = decision.thread.conversationId;
      session = { providerId: pid, webSessionId: decision.thread.webSessionId, parentMessageId: decision.thread.parentMessageId };
      // 2026-09-09（feat/vision-multimodal）：incremental tail 也要 string content（vision multimodal
      // 首次请求带图时，tail 也含 array content 的 user message —— 用 string 版渲染）。
      const tail = decision.tail.map((m) => ({
        ...m,
        content: typeof m.content === 'string' || m.content === null ? m.content : renderMessageContent(m),
      }));
      prompt = renderTail(tail) + toolCtx.promptSuffix;
      this.d.mapper.markBusy(pid, convId, ctx.requestId);
    }
    if (prompt.length > resolved.limitChars) {
      await this.d.mapper.fail(pid, convId, ctx.requestId);
      throw err('invalid_request_error', `transcript too long: ${prompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
    }
    const run: RunState = { parentMessageId: null, repairDone: false, model: resolved, promptLen: prompt.length };
    const req: ProviderCompletion = { session, prompt, model: { modelType: resolved.modelType, thinking: resolved.thinking }, overrides, requestId: ctx.requestId, ...(refFileIds.length ? { refFileIds } : {}) };
    const handle: RunHandle = {
      stream: null as unknown as AsyncIterable<ProviderStreamEvent>,
      session, convId, thread, run,
      action: decision.action === 'incremental' ? 'incremental' : 'rebuild',
      threadFound: decision.action !== 'rebuild' || decision.existing !== null,
      mirrorLen: decision.action === 'incremental' ? decision.thread.mirror.length
        : decision.action === 'rebuild' && decision.existing ? decision.existing.mirror.length : undefined,
      deletedOld: decision.action === 'rebuild' && decision.existing !== null,
    };
    const mirrorLenAtDecision = decision.action === 'incremental' ? decision.thread.mirror.length : -1;
    handle.stream = this.runExclusiveStream(provider, ctx, req, async () => {
      // 2026-09-11（fix/review-r1）：排队等待期间，同会话的另一请求可能已 commit（parent_message_id
      // 链 + mirror 已推进）。若仍按入队前的快照发，会在服务端分叉出 sibling 分支，且本轮 commit
      // 会覆写 mirror。拿锁后校验：被推进就基于最新状态重新 decide（incremental 重取 tail/parent，
      // 否则走 rebuild 全量转录）；只有确实没变才沿用原请求。
      if (decision.action !== 'incremental') return;
      const live = this.d.mapper.peek(pid, handle.convId);
      if (live && live.mirror.length === mirrorLenAtDecision) {
        req.session.parentMessageId = live.parentMessageId;   // 防御性刷新（同一对象，通常无变化）
        return;
      }
      const d2 = this.d.mapper.decide(pid, messages, conversationId, resolved.modelType);
      if (d2.action === 'error') throw err(d2.code, d2.message, 400);
      if (d2.action === 'incremental') {
        this.d.mapper.markBusy(pid, d2.thread.conversationId, ctx.requestId);
        const tail = d2.tail.map((m) => ({
          ...m,
          content: typeof m.content === 'string' || m.content === null ? m.content : renderMessageContent(m),
        }));
        const nextPrompt = renderTail(tail) + toolCtx.promptSuffix;
        if (nextPrompt.length > resolved.limitChars) {
          await this.d.mapper.fail(pid, d2.thread.conversationId, ctx.requestId);
          throw err('invalid_request_error', `transcript too long: ${nextPrompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
        }
        req.prompt = nextPrompt;
        req.session = { providerId: pid, webSessionId: d2.thread.webSessionId, parentMessageId: d2.thread.parentMessageId };
        handle.session = req.session; handle.convId = d2.thread.conversationId; handle.thread = d2.thread;
        handle.action = 'incremental'; handle.mirrorLen = d2.thread.mirror.length; handle.deletedOld = false;
        handle.run.promptLen = nextPrompt.length;
        return;
      }
      // 重决策为 rebuild：旧 thread 已不属于本次请求的上下文（或被并发请求淘汰），销毁重建。
      if (d2.existing) {
        try { await provider.deleteSession(ctx, { providerId: pid, webSessionId: d2.existing.webSessionId, parentMessageId: d2.existing.parentMessageId }); } catch { /* best effort per spec */ }
      }
      const s = await provider.createSession(ctx);
      const newConvId = d2.existing?.conversationId ?? conversationId ?? this.d.mapper.nextAutoConversationId();
      const t2 = this.d.mapper.register(pid, newConvId, s.webSessionId, messages, resolved.modelType);
      const full = renderTranscript(stringMessages);
      const nextPrompt = (full.ok ? full.prompt : '') + toolCtx.promptSuffix;
      if (nextPrompt.length > resolved.limitChars) {
        await this.d.mapper.fail(pid, newConvId, ctx.requestId);
        throw err('invalid_request_error', `transcript too long: ${nextPrompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
      }
      req.prompt = nextPrompt;
      req.session = { providerId: pid, webSessionId: s.webSessionId, parentMessageId: null };
      handle.session = req.session; handle.convId = newConvId; handle.thread = t2;
      handle.action = 'rebuild'; handle.mirrorLen = t2.mirror.length; handle.deletedOld = d2.existing !== null; handle.threadFound = true;
      handle.run.promptLen = nextPrompt.length;
    });
    return handle;
  }

  private runExclusiveStream(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion, afterLock?: () => Promise<void>): AsyncIterable<ProviderStreamEvent> {
    // 队列锁：acquire() 立即返回 release；生成器在 finally 调用 release；超时 60s 抛 QueueTimeoutError → mapErr → 429（spec §4.3/§10）
    const queue = this.d.queue;
    const locked = queue.acquire(`${req.session.providerId}:${req.session.webSessionId}`);
    const src = this.streamWithRetry(provider, ctx, req);
    const gen = (async function* () {
      let release = await locked;
      try {
        // afterLock 在拉流前执行；prompt/session 的改写要在 streamWithRetry 真正调用 provider 之前完成
        if (afterLock) {
          const key0 = `${req.session.providerId}:${req.session.webSessionId}`;
          await afterLock();
          const key1 = `${req.session.providerId}:${req.session.webSessionId}`;
          // 2026-09-11（fix/review-r2 N3）：重决策可能换到另一个 webSessionId —— 必须补齐新 key 的锁。
          // **先放旧锁再取新锁**：concurrency=poolSize 下持有旧槽位再等新槽位可能永远等不到（自己占满名额）。
          // 释放与取新锁之间无并发风险：重决策/建会话已完成，取到新锁才开始拉流；
          // 若取锁超时则整个请求以 429 失败（有界，不挂死）。
          if (key1 !== key0) {
            release();
            release = await queue.acquire(key1);
          }
        }
        for await (const ev of src) yield ev;
      }
      finally { release(); }
    })();
    return gen;
  }

  private async *streamWithRetry(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        for await (const ev of provider.streamCompletion(ctx, req)) {
          if (isContentEvent(ev)) emitted = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (!emitted && attempt < 3 && provider.isRateLimited(e)) {
          await sleep(500 * 2 ** attempt);   // 500ms ×2^n，n<3（spec §6.4）
          continue;
        }
        throw e;
      }
    }
  }

  private consumeEvent(ev: ProviderStreamEvent, agg: StreamAggregate, run: RunState): void {
    switch (ev.kind) {
      case 'message_id': run.parentMessageId = ev.id; break;
      case 'think_delta': agg.reasoning += ev.content; break;
      case 'content_delta': agg.content += ev.content; if (ev.finish_reason) agg.finishReason = ev.finish_reason; break;
      case 'usage':   // spec：usage 仅当 input/output 都可得时透出
        if (ev.inputTokens > 0 && ev.outputTokens >= 0) {
          agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
        }
        break;
      // 2026-09-09（diag/pro-sse-paths）：诊断现场，SSE 流末 emit。run.sseBytes/ssePaths 由 done() 透出到 log。
      case 'stream_stats':
        run.sseBytes = ev.bytes;
        run.ssePaths = ev.paths;
        run.sseRaw = ev.rawSample;
        // 2026-09-11（diag/continue-thinking）：spike 期间诊断字段。
        run.sseStatusValues = ev.statusValues;
        run.sseThinkingChars = ev.thinkingChars;
        run.sseResponseChars = ev.responseChars;
        run.sseRawTail = ev.rawTail;
        break;
    }
  }

  private async finalize(provider: ProviderAdapter, handle: { session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, messages: Message[], agg: StreamAggregate, ctx: ProviderContext, toolCtx: ToolContext): Promise<void> {
    let toolCalls: ToolCall[] = [];
    if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
      const parsed = parseToolCalls(agg.content, toolCtx.tools);
      if (parsed) {
        toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls';
      } else if (!hasToolTags(agg.content)) {
        // 模型未输出工具标签（tool_choice:auto 时不调用也是合法的）→ 正常 stop，不 repair
        agg.finishReason = agg.finishReason ?? 'stop';
      } else {
        // 模型兜底：同一会话追加修复指令重问 1 次（spec §4.4 第 3 层）；该轮不入镜像，
        // 下一轮客户端消息将因镜像前缀不匹配而重建——安全降级（spec §4.3）
        let p2: { calls: ToolCall[]; remainder: string } | null = null;
        try { p2 = await this.repairToolCalls(provider, ctx, handle, agg.content, toolCtx); }
        catch (e) {
          await this.d.mapper.fail(provider.id, handle.convId, ctx.requestId);
          if (e instanceof BridgeError) throw e;
          throw err('invalid_request_error', 'tool call parse failed', 400);
        }
        if (p2) { toolCalls = p2.calls; agg.content = p2.remainder; agg.finishReason = 'tool_calls'; }
        else { await this.d.mapper.fail(provider.id, handle.convId, ctx.requestId); throw err('invalid_request_error', 'tool call parse failed after repair retry', 400); }
      }
    }
    // mirror 必须含 assistant 回复：下一轮 client 传 [..., user 新问题] 时，
    // tail 首条是 user → 命中 incremental → 复用同一 DeepSeek 会话与 parent_message_id 链（上下文不丢）。
    const mirrorMessages: Message[] = [...messages, { role: 'assistant', content: agg.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
    // 2026-09-09（fix/model-switch-rebuild）：commit 时同步 modelType，让 mapper 跟踪 cid ↔ 模型。
    this.d.mapper.commit(provider.id, handle.convId, mirrorMessages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId, handle.run.model.modelType);
    agg.toolCalls = toolCalls;
    agg.finishReason = agg.finishReason ?? 'stop';
  }

  /**
   * spec §4.4 第 3 层兜底：同一会话追加修复指令重问 1 次；解析不出返回 null。
   * 直调 provider.streamCompletion 而不走 runExclusiveStream——两个调用点（finalize / encodeStream）
   * 都在 provider 流已耗尽之后，此时队列锁已释放，再 acquire 会自锁（60s 超时 → 429）。
   * 2026-09-10（fix/dsml-no-silent-leak）：从 finalize 内联块抽出，流式路径共用同一套 repair。
   */
  private async repairToolCalls(
    provider: ProviderAdapter, ctx: ProviderContext,
    handle: { session: ProviderSession; convId: string; run: RunState },
    raw: string, toolCtx: ToolContext,
  ): Promise<{ calls: ToolCall[]; remainder: string } | null> {
    handle.run.repairDone = true;   // 先置位：repair 自身失败时不重复重问
    const repairReq: ProviderCompletion = {
      session: { ...handle.session, parentMessageId: handle.run.parentMessageId ?? handle.session.parentMessageId },
      prompt: `${REPAIR_INSTRUCTION}\n\n${raw}`,
      model: { modelType: handle.run.model.modelType, thinking: handle.run.model.thinking },
      requestId: `${ctx.requestId}-repair`,
    };
    let buf = '';
    for await (const ev of provider.streamCompletion(ctx, repairReq)) if (ev.kind === 'content_delta') buf += ev.content;
    return parseToolCalls(buf, toolCtx.tools);
  }

  private encodeStream(provider: ProviderAdapter, handle: RunHandle, ctx: ProviderContext, model: string, started: number, messages: Message[], toolCtx: ToolContext, done: (ok: boolean, ms: number, error?: string, extra?: { finishReason?: string; parentMessageId?: string | number | null; replySample?: string; rawSample?: string; reasoningSample?: string; sseBytes?: number; ssePaths?: string[]; sseRaw?: string; sseStatusValues?: string[]; sseThinkingChars?: number; sseResponseChars?: number; sseRawTail?: string }) => void): AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> } {
    const cctx: StreamContext = { id: `chatcmpl-${ctx.requestId}`, model, created: Math.floor(started / 1000) };
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    // 2026-09-10（feat/log-b64-export）：归一化**前**的模型原文。归一化器的输出才是 agg.content，
    // 光看它无法判断上游到底吐了什么形状——字节级取证必须拿归一化前的原串。
    let rawContent = '';
    const self = this;
    const gen = (async function* () {
      let completed = false;
      let queueTimeout = false;   // QueueTimeoutError = 从未进入会话（见 finally 里的 N2 处理）
      try {
        // 2026-09-10（fix/dsml-tool-parser）：带 tools 时 content 增量先过 DSML 归一化器。
        // DeepSeek V4 的原生工具协议是 DSML（<｜DSML｜tool_calls> / <｜DSML｜invoke name="X">）；
        // 直接透传使用方（spice）按标准 <tool_calls> 解析不了。归一化器在块外逐段透传
        // （只扣住可能是起始标记前缀的尾巴），块内缓冲到结束标记后重写成标准 <tool_calls> JSON。
        const dsml = toolCtx.promptSuffix !== '' ? createDsmlStreamNormalizer(toolCtx.tools) : null;
        // 队列锁已在 runCompletion 内的 runExclusiveStream 持有，此处直接消费 handle.stream 即可。
        for await (const ev of handle.stream) {
          if (dsml && ev.kind === 'content_delta') {
            rawContent += ev.content;
            const text = dsml.feed(ev.content);
            if (text) {
              agg.content += text;
              for (const c of eventToChunks({ ...ev, content: text }, cctx)) yield c;
            }
            continue;
          }
          // 2026-09-11（fix/review-r1）：usage 不发中间分块——spec §4.5 要求 usage 只在终止分块输出，
          // 且仅当 input/output 计数都可得（不编造）。旧实现在判据**之前**就 eventToChunks(usage)
          // 无条件发出 prompt_tokens:0 的伪造块，且与 finalChunk 重复。
          if (ev.kind === 'usage') {
            if (ev.inputTokens > 0 && ev.outputTokens >= 0) {
              agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
            }
            continue;
          }
          for (const c of eventToChunks(ev, cctx)) yield c;
          if (ev.kind === 'content_delta') agg.content += ev.content;
          if (ev.kind === 'think_delta') agg.reasoning += ev.content;
          if (ev.kind === 'message_id') handle.run.parentMessageId = ev.id;
          // 2026-09-09（fix/encode-stream-stats）：stream 路径补 case 与 non-stream 路径（consumeEvent）保持一致
          if (ev.kind === 'stream_stats') {
            handle.run.sseBytes = ev.bytes;
            handle.run.ssePaths = ev.paths;
            handle.run.sseRaw = ev.rawSample;
            // 2026-09-11（diag/continue-thinking）：spike 期间诊断字段。
            handle.run.sseStatusValues = ev.statusValues;
            handle.run.sseThinkingChars = ev.thinkingChars;
            handle.run.sseResponseChars = ev.responseChars;
            handle.run.sseRawTail = ev.rawTail;
          }
        }
        if (dsml) {
          const tail = dsml.flush();
          if (tail) {
            agg.content += tail;
            for (const c of eventToChunks({ kind: 'content_delta', content: tail }, cctx)) yield c;
          }
        }
        // 2026-09-09（fix/mirror-content）：SSE content delta 发出的原始完整文本（含 <tool_calls> 标签），
        // 与 spice 端 asst.content 保持一致——parseToolCalls 剥标签后的 remainder 只用于
        // 非流式聚合返回（toAggregate）与 toolCalls 提取，不再写进 mirror。
        const sentRawContent = agg.content;
        // 2026-09-10（fix/dsml-no-silent-leak）：归一化器扣下的块不计入 agg.content（它已 fail-closed），
        // 所以「有工具标记」的判据必须把 unparsed 一起算——否则扣下的块会被静默丢弃并判成 stop。
        const heldBack = dsml?.unparsed ?? [];
        if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
          const parsed = parseToolCalls(agg.content, toolCtx.tools);
          if (parsed) {
            agg.toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls';
            // OpenAI SSE 兼容：每个 tool_call 拆为独立 chunk，带 index，让消费者可按 index 增量拼接
            for (const tc of toolCallDeltaChunks(cctx, parsed.calls)) yield tc;
          } else if (heldBack.length === 0 && !hasToolTags(agg.content)) {
            // 模型未输出工具标签：合法（tool_choice:auto 可不调用），正常 stop
            agg.finishReason = agg.finishReason ?? 'stop';
          } else {
            // 工具标记在但解析不出 → 对齐 finalize()：repair 一次，仍失败则 400。
            // 旧实现没有这个分支：DSML 原文被当正文透传 + finish_reason=stop，下游看不到任何异常。
            let p2: { calls: ToolCall[]; remainder: string } | null = null;
            try { p2 = await self.repairToolCalls(provider, ctx, handle, [sentRawContent, ...heldBack].filter(Boolean).join('\n'), toolCtx); }
            catch (e) { await self.d.mapper.fail(provider.id, handle.convId, ctx.requestId); throw e; }
            if (p2) {
              agg.toolCalls = p2.calls; agg.content = p2.remainder; agg.finishReason = 'tool_calls';
              for (const tc of toolCallDeltaChunks(cctx, p2.calls)) yield tc;
            } else {
              await self.d.mapper.fail(provider.id, handle.convId, ctx.requestId);
              throw err('invalid_request_error', 'tool call parse failed after repair retry', 400);
            }
          }
        }
        yield finalChunk(cctx, agg.finishReason ?? 'stop', agg.usage);
        // 2026-09-09（fix/mirror-content）：mirror 的 asst.content 必须与「发送给 spice 的 SSE content」一致。
        // SSE content delta 发出的是 LLM 完整输出（**含** <tool_calls> 标签文本），spice 端 asst.content
        // 存盘、回发的就是这段完整文本；而这里 agg.content 已被 parseToolCalls 剥成 remainder（**不含**标签）
        // → 下一轮 spice 回灌时同一条 asst content 两边不一致 → mirrorIsPrefix 失败 → rebuild 删旧 thread。
        // 修：mirror 用剥前原始文本（sentRawContent），与 SSE 发出的 content 保持一致。
        const mirrorMessages: Message[] = [...messages, { role: 'assistant', content: sentRawContent, ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}) }];
        // 2026-09-09（fix/model-switch-rebuild）：commit 时同步 modelType。
        self.d.mapper.commit(provider.id, handle.convId, mirrorMessages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId, handle.run.model.modelType);
        completed = true;
        done(true, self.d.now() - started, undefined, { finishReason: agg.finishReason ?? 'stop', parentMessageId: handle.run.parentMessageId, replySample: agg.content.slice(0, 1200), rawSample: rawContent.slice(0, B64_SAMPLE_CHARS), reasoningSample: agg.reasoning.slice(0, 200), sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw, sseStatusValues: handle.run.sseStatusValues, sseThinkingChars: handle.run.sseThinkingChars, sseResponseChars: handle.run.sseResponseChars, sseRawTail: handle.run.sseRawTail });
      } catch (e) {
        // 2026-09-10（feat/log-b64-export）：失败路径（含工具解析失败 400）也要带现场样本——
        // 这正是最需要字节证据的场景（旧实现只记 error，拿不到模型原文）。
        done(false, self.d.now() - started, (e as Error).message, { replySample: agg.content.slice(0, 1200), rawSample: rawContent.slice(0, B64_SAMPLE_CHARS), sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw, sseStatusValues: handle.run.sseStatusValues, sseThinkingChars: handle.run.sseThinkingChars, sseResponseChars: handle.run.sseResponseChars, sseRawTail: handle.run.sseRawTail });
        queueTimeout = e instanceof QueueTimeoutError;
        throw mapErrStatic(e, self.d.registry);
      } finally {
        // 2026-09-11（fix/review-r1）：未正常 commit 就退出（异常或消费方 cancel/break 触发 generator
        // return）→ 销毁线程；否则 incremental 的 busy 永不复位、mirror 停留在旧位置，
        // 下一轮要么被 decide 跳过（幽灵 busy），要么拿陈旧 parent 链继续聊（串台风险）。
        // 2026-09-11（fix/review-r2 N2）：队列超时说明本请求从未进入会话，不得销毁（会话是在途请求的）；
        // token 保证只销毁本请求持有的线程（同 cid 并发场景）。
        if (!completed && !queueTimeout) { try { await self.d.mapper.fail(provider.id, handle.convId, ctx.requestId); } catch { /* best effort */ } }
      }
    })();
    return {
      [Symbol.asyncIterator]: () => gen,
      async cancel() { try { await provider.stopStream(ctx, handle.session, handle.run.parentMessageId); } catch { /* best effort */ } },
    };
  }

  private mapErr(e: unknown): BridgeError {
    return mapErrStatic(e, this.d.registry);
  }

  /** 2026-09-11（fix/review-r1）：面板改 poolSize/TTL 时实时生效（spec §8.2）。
   *  旧实现只写 storage，已缓存的 SessionMapper/Queue 仍用构造时的值，要等 SW 被回收才生效。 */
  setPoolSize(n: number): void {
    this.d.mapper.setPoolSize(n);
    this.d.queue.setConcurrency(n);
  }

  setTtlMinutes(minutes: number): void {
    this.d.mapper.setTtlMs(Math.max(1, Math.floor(minutes) || 1) * 60_000);
  }
}

function mapErrStatic(e: unknown, registry: Record<ProviderId, ProviderAdapter>): BridgeError {
  if (e instanceof BridgeError) return e;
  if (e instanceof QueueTimeoutError) return err('rate_limited', 'busy: request queue wait exceeded 60s', 429);
  for (const a of Object.values(registry)) {
    if (a.isAuthExpired(e)) return err('provider_unavailable', '登录已过期，请在扩展面板重新登录', 503);
    if (a.isRateLimited(e)) return err('rate_limited', '网页端限流，请稍后重试', 429);
    if (a.isUnavailable(e)) return err('provider_unavailable', 'provider unavailable（网络/WAF/未登录）', 503);
  }
  return err('internal_error', (e as Error).message ?? 'unknown error', 500);
}

// 2026-09-10（feat/models-sync）：从 storage 读 catalog，带 7d TTL 验证。返 null 表示 fall back 到 hardcoded。
interface CatalogShape { capturedAt: number; models: { label: string; value?: string }[] }
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
async function loadCatalogFromStorage(
  storage: RouterDeps['storage'],
): Promise<CatalogShape | null> {
  try {
    const raw = await storage.get('modelsCatalog');
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<CatalogShape>;
    if (typeof r.capturedAt !== 'number' || !Array.isArray(r.models)) return null;
    if (Date.now() - r.capturedAt > CATALOG_TTL_MS) return null;
    return r as CatalogShape;
  } catch { return null; }
}
