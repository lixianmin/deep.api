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

export interface RouterDeps {
  registry: Record<ProviderId, ProviderAdapter>;
  mapper: SessionMapper;
  queue: Queue;
  storage: { get(k: string): Promise<unknown | undefined>; set(k: string, v: unknown): Promise<void> };
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
}

const NO_PROGRESS_MS = 600_000;          // spec §4.5 兜底断流
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
    // （Task 3 getModelsCatalog 写到 storage）——匹配 id 后用 catalog label 替换 description。
    // catalog 缺失 / 超 7 天 TTL → fall back 到 hardcoded。
    const catalog = await loadCatalogFromStorage(this.d.storage);
    if (!catalog) return { object: 'list', data: hardcoded };
    return {
      object: 'list',
      data: hardcoded.map((m) => {
        const label = catalog.models.find((o) => labelToModelId(o.label) === m.id)?.label;
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
            // 2026-09-10（fix/vision-errors）：poll 上限 10×2s→5×1.5s（7.5s）。超时已不再抛错
            // （adapter 内记录 + 继续），缩短只为改善“带图发送卡很久”的体验。
            await provider.pollFileReady(ctx, up.id, { maxAttempts: 5, intervalMs: 1500 });
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
      const code = (e instanceof BridgeError) ? e.error.error.code : 'provider_unavailable';
      this.d.log.push({
        at: this.d.now(), provider: provider.id, model: modelId, ok: false, ms: this.d.now() - started, error: msg, version: this.d.version,
        finishReason: undefined, parentMessageId: null,
        replySample: undefined, reasoningSample: undefined, sseBytes: undefined, ssePaths: undefined, sseRaw: undefined,
        messagesFull: JSON.stringify(messages),
        mirrorFull: undefined,
      });
      if (e instanceof BridgeError) throw e;
      throw err(code as never, `vision pipeline failed: ${msg}`, 502);
    }
    const refFileIds: string[] = (ctx as { refFileIds?: string[] }).refFileIds ?? [];
    // 2026-09-09（feat/vision-multimodal）：array content → 渲染成 prompt 字符串 + 标记有图位置。
    // 不修改原 messages（mirror 要存原 array 形态），复制一份 string 版给 renderTranscript/renderTail。
    const stringMessages: Message[] = messages.map((m) => ({
      ...m,
      content: typeof m.content === 'string' || m.content === null ? m.content : renderMessageContent(m),
    }));

    const toolCtx = buildToolPrompt((p.tools as ToolDef[] | undefined) ?? [], (p.tool_choice as ToolChoice | undefined) ?? 'auto');
    // 调用方可覆盖 thinking/search/reasoning_effort；undefined 字段被下游忽略
    const overrides = {
      thinking: (p.thinking ?? undefined) as boolean | null | undefined,
      search: (p.search ?? undefined) as boolean | undefined,
      reasoningEffort: (p.reasoning_effort ?? undefined) as 'low' | 'medium' | 'high' | 'max' | undefined,
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
    const requestFull = JSON.stringify({
      modelType: resolved.modelType,
      thinking: resolved.thinking,
      overrides,
      toolChoice: p.tool_choice ?? 'auto',
      tools: ((p.tools as ToolDef[] | undefined) ?? []).map((t) => t.function?.name),
      refFileIds: refFileIds.length,
      promptLen: handle.run.promptLen,
    });
    const diag = {
      cid: handle.convId, msgsLen: messages.length, action: handle.thread.kind ? (preDecide.action === 'incremental' ? 'incremental' as const : 'rebuild' as const) : undefined,
      threadFound, mirrorLen,
      deletedOld: preDecide.action === 'rebuild' && preDecide.existing !== null,
      webSessionId: handle.session.webSessionId,
    };
    const done = (ok: boolean, ms: number, error?: string, extra?: { finishReason?: string; parentMessageId?: string | number | null; replySample?: string; reasoningSample?: string; sseBytes?: number; ssePaths?: string[]; sseRaw?: string }) =>
      this.d.log.push({
        at: this.d.now(), provider: provider.id, model: modelId, ok, ms, error, version: this.d.version, ...diag,
        finishReason: extra?.finishReason, parentMessageId: extra?.parentMessageId,
        replySample: extra?.replySample,
        reasoningSample: extra?.reasoningSample,
        sseBytes: extra?.sseBytes,
        ssePaths: extra?.ssePaths,
        sseRaw: extra?.sseRaw,
        firstDiffIdx,
        requestFull,
        messagesFull: JSON.stringify(messages),
        mirrorFull: threadFound
          ? JSON.stringify(preDecide.action === 'incremental' ? preDecide.thread.mirror
            : preDecide.action === 'rebuild' && preDecide.existing ? preDecide.existing.mirror : [])
          : undefined,
      });
    if (p.stream === true) return this.encodeStream(provider, handle, ctx, modelId, started, messages, toolCtx, done);
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    try {
      for await (const ev of handle.stream) this.consumeEvent(ev, agg, handle.run);
      await this.finalize(provider, handle, messages, agg, ctx, toolCtx);
    } catch (e) {
      done(false, this.d.now() - started, (e as Error).message);
      throw this.mapErr(e);
    }
    done(true, this.d.now() - started, undefined, { finishReason: agg.finishReason ?? 'stop', parentMessageId: handle.run.parentMessageId, replySample: agg.content.slice(0, 200), reasoningSample: agg.reasoning.slice(0, 200), sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw });
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
  ): Promise<{ stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }> {
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
      this.d.mapper.markBusy(pid, convId);
    }
    if (prompt.length > resolved.limitChars) {
      await this.d.mapper.fail(pid, convId);
      throw err('invalid_request_error', `transcript too long: ${prompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
    }
    const run: RunState = { parentMessageId: null, repairDone: false, model: resolved, promptLen: prompt.length };
    const req: ProviderCompletion = { session, prompt, model: { modelType: resolved.modelType, thinking: resolved.thinking }, overrides, requestId: ctx.requestId, ...(refFileIds.length ? { refFileIds } : {}) };
    const stream = this.runExclusiveStream(provider, ctx, req);
    return { stream, session, convId, thread, run };
  }

  private runExclusiveStream(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
    // 队列锁：acquire() 立即返回 release；生成器在 finally 调用 release；超时 60s 抛 QueueTimeoutError → mapErr → 429（spec §4.3/§10）
    const locked = this.d.queue.acquire(`${req.session.providerId}:${req.session.webSessionId}`);
    const src = this.streamWithRetry(provider, ctx, req);
    const gen = (async function* () {
      const release = await locked;
      try { for await (const ev of src) yield ev; }
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
        handle.run.repairDone = true;
        const repairReq: ProviderCompletion = {
          session: { ...handle.session, parentMessageId: handle.run.parentMessageId ?? handle.session.parentMessageId },
          prompt: `${REPAIR_INSTRUCTION}\n\n${agg.content}`,
          model: { modelType: handle.run.model.modelType, thinking: handle.run.model.thinking },
          requestId: `${ctx.requestId}-repair`,
        };
        let buf = '';
        try {
          for await (const ev of provider.streamCompletion(ctx, repairReq)) if (ev.kind === 'content_delta') buf += ev.content;
          const p2 = parseToolCalls(buf, toolCtx.tools);
          if (p2) { toolCalls = p2.calls; agg.content = p2.remainder; agg.finishReason = 'tool_calls'; }
          else { await this.d.mapper.fail(provider.id, handle.convId); throw err('invalid_request_error', 'tool call parse failed after repair retry', 400); }
        } catch (e) {
          if (e instanceof BridgeError) { await this.d.mapper.fail(provider.id, handle.convId); throw e; }
          await this.d.mapper.fail(provider.id, handle.convId);
          throw err('invalid_request_error', 'tool call parse failed', 400);
        }
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

  private encodeStream(provider: ProviderAdapter, handle: { stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, ctx: ProviderContext, model: string, started: number, messages: Message[], toolCtx: ToolContext, done: (ok: boolean, ms: number, error?: string, extra?: { finishReason?: string; parentMessageId?: string | number | null; replySample?: string; reasoningSample?: string; sseBytes?: number; ssePaths?: string[]; sseRaw?: string }) => void): AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> } {
    const cctx: StreamContext = { id: `chatcmpl-${ctx.requestId}`, model, created: Math.floor(started / 1000) };
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    const self = this;
    const gen = (async function* () {
      try {
        // 2026-09-10（fix/dsml-tool-parser）：带 tools 时 content 增量先过 DSML 归一化器。
        // DeepSeek V4 的原生工具协议是 DSML（<｜DSML｜tool_calls> / <｜DSML｜invoke name="X">）；
        // 直接透传使用方（spice）按标准 <tool_calls> 解析不了。归一化器在块外逐段透传
        // （只扣住可能是起始标记前缀的尾巴），块内缓冲到结束标记后重写成标准 <tool_calls> JSON。
        const dsml = toolCtx.promptSuffix !== '' ? createDsmlStreamNormalizer(toolCtx.tools) : null;
        // 队列锁已在 runCompletion 内的 runExclusiveStream 持有，此处直接消费 handle.stream 即可。
        for await (const ev of handle.stream) {
          if (dsml && ev.kind === 'content_delta') {
            const text = dsml.feed(ev.content);
            if (text) {
              agg.content += text;
              for (const c of eventToChunks({ ...ev, content: text }, cctx)) yield c;
            }
            continue;
          }
          for (const c of eventToChunks(ev, cctx)) yield c;
          if (ev.kind === 'content_delta') agg.content += ev.content;
          if (ev.kind === 'think_delta') agg.reasoning += ev.content;
          if (ev.kind === 'message_id') handle.run.parentMessageId = ev.id;
          if (ev.kind === 'usage' && ev.inputTokens > 0 && ev.outputTokens >= 0) {
            agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
          }
          // 2026-09-09（fix/encode-stream-stats）：stream 路径补 case 与 non-stream 路径（consumeEvent）保持一致
          if (ev.kind === 'stream_stats') {
            handle.run.sseBytes = ev.bytes;
            handle.run.ssePaths = ev.paths;
            handle.run.sseRaw = ev.rawSample;
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
        if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
          const parsed = parseToolCalls(agg.content, toolCtx.tools);
          if (parsed) {
            agg.toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls';
            // OpenAI SSE 兼容：每个 tool_call 拆为独立 chunk，带 index，让消费者可按 index 增量拼接
            for (const tc of toolCallDeltaChunks(cctx, parsed.calls)) yield tc;
          } else if (!hasToolTags(agg.content)) {
            // 模型未输出工具标签：合法（tool_choice:auto 可不调用），正常 stop
            agg.finishReason = agg.finishReason ?? 'stop';
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
        done(true, self.d.now() - started, undefined, { finishReason: agg.finishReason ?? 'stop', parentMessageId: handle.run.parentMessageId, replySample: agg.content.slice(0, 200), reasoningSample: agg.reasoning.slice(0, 200), sseBytes: handle.run.sseBytes, ssePaths: handle.run.ssePaths, sseRaw: handle.run.sseRaw });
      } catch (e) {
        done(false, self.d.now() - started, (e as Error).message);
        throw mapErrStatic(e, self.d.registry);
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
