import { BridgeError } from '../shared/protocol';
import type { ApiErrorCode, ChatCompletion, ChatCompletionChunk, Message, ModelInfo, ToolCall, ToolChoice, ToolDef } from '../shared/api-types';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderId, ProviderSession, ProviderStreamEvent, ResolvedModel } from './providers/adapter';
import { SessionMapper, type ThreadEntry } from './session-mapper';
import { Queue, QueueTimeoutError } from './queue';
import { renderTranscript, renderTail, limitCharsFor } from './transcript-renderer';
import { eventToChunks, finalChunk, toAggregate, type StreamAggregate, type StreamContext } from './chunk-encoder';
import { buildToolPrompt, parseToolCalls, hasToolTags, type ToolContext } from './tool-pipeline';
import type { RingLog } from './log';

export interface RouterDeps {
  registry: Record<ProviderId, ProviderAdapter>;
  mapper: SessionMapper;
  queue: Queue;
  storage: { get(k: string): Promise<unknown | undefined>; set(k: string, v: unknown): Promise<void> };
  log: RingLog;
  now(): number;
}

function err(code: ApiErrorCode, message: string, status: number): BridgeError {
  return new BridgeError({ error: { message, type: 'api_error', code } }, status);
}

interface RunState {
  parentMessageId: number | string | null;
  repairDone: boolean;
  model: ResolvedModel;
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
    return { object: 'list', data: Object.values(this.d.registry).flatMap(p => p.models) };
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
    const toolCtx = buildToolPrompt((p.tools as ToolDef[] | undefined) ?? [], (p.tool_choice as ToolChoice | undefined) ?? 'auto');
    const handle = await this.runCompletion(provider, resolved, messages, toolCtx, p.conversation_id as string | undefined, ctx);
    const done = (ok: boolean, ms: number, error?: string) => this.d.log.push({ at: this.d.now(), provider: provider.id, model: modelId, ok, ms, error });
    if (p.stream === true) return this.encodeStream(provider, handle, ctx, modelId, started, messages, toolCtx, done);
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    try {
      for await (const ev of handle.stream) this.consumeEvent(ev, agg, handle.run);
      await this.finalize(provider, handle, messages, agg, ctx, toolCtx);
    } catch (e) {
      done(false, this.d.now() - started, (e as Error).message);
      throw this.mapErr(e);
    }
    done(true, this.d.now() - started);
    return toAggregate({ id: `chatcmpl-${ctx.requestId}`, model: modelId, created: Math.floor(started / 1000) }, agg);
  }

  private resolve(model: string): ProviderAdapter {
    for (const a of Object.values(this.d.registry)) if (a.resolveModel(model)) return a;
    throw err('invalid_request_error', `unknown model: ${model}`, 400);
  }

  private async runCompletion(
    provider: ProviderAdapter, resolved: ResolvedModel, messages: Message[], toolCtx: ToolContext,
    conversationId: string | undefined, ctx: ProviderContext,
  ): Promise<{ stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }> {
    const pid = provider.id;
    const decision = this.d.mapper.decide(pid, messages, conversationId);
    if (decision.action === 'error') throw err(decision.code, decision.message, 400);
    let session: ProviderSession; let convId: string; let thread: ThreadEntry; let prompt: string;
    if (decision.action === 'rebuild') {
      if (decision.existing) {
        try { await provider.deleteSession(ctx, { providerId: pid, webSessionId: decision.existing.webSessionId, parentMessageId: decision.existing.parentMessageId }); } catch { /* best effort per spec */ }
      }
      const s = await provider.createSession(ctx);
      convId = decision.existing?.conversationId ?? this.d.mapper.nextAutoConversationId();
      thread = this.d.mapper.register(pid, convId, s.webSessionId, messages);
      session = { providerId: pid, webSessionId: s.webSessionId, parentMessageId: null };
      prompt = renderTranscript(messages).ok
        ? (renderTranscript(messages) as { ok: true; prompt: string }).prompt + toolCtx.promptSuffix
        : '';   // 超限在下方统一检查
    } else {
      thread = decision.thread; convId = decision.thread.conversationId;
      session = { providerId: pid, webSessionId: decision.thread.webSessionId, parentMessageId: decision.thread.parentMessageId };
      prompt = renderTail(decision.tail) + toolCtx.promptSuffix;
      this.d.mapper.markBusy(pid, convId);
    }
    if (prompt.length > resolved.limitChars) {
      await this.d.mapper.fail(pid, convId);
      throw err('invalid_request_error', `transcript too long: ${prompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
    }
    const run: RunState = { parentMessageId: null, repairDone: false, model: resolved };
    const req: ProviderCompletion = { session, prompt, model: { modelType: resolved.modelType, thinking: resolved.thinking }, requestId: ctx.requestId };
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
    }
  }

  private async finalize(provider: ProviderAdapter, handle: { session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, messages: Message[], agg: StreamAggregate, ctx: ProviderContext, toolCtx: ToolContext): Promise<void> {
    let toolCalls: ToolCall[] = [];
    if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
      const parsed = parseToolCalls(agg.content);
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
          const p2 = parseToolCalls(buf);
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
    this.d.mapper.commit(provider.id, handle.convId, mirrorMessages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId);
    agg.toolCalls = toolCalls;
    agg.finishReason = agg.finishReason ?? 'stop';
  }

  private encodeStream(provider: ProviderAdapter, handle: { stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, ctx: ProviderContext, model: string, started: number, messages: Message[], toolCtx: ToolContext, done: (ok: boolean, ms: number, error?: string) => void): AsyncIterable<ChatCompletionChunk> & { cancel(): Promise<void> } {
    const cctx: StreamContext = { id: `chatcmpl-${ctx.requestId}`, model, created: Math.floor(started / 1000) };
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    const self = this;
    const gen = (async function* () {
      try {
        // 队列锁已在 runCompletion 内的 runExclusiveStream 持有，此处直接消费 handle.stream 即可。
        for await (const ev of handle.stream) {
          for (const c of eventToChunks(ev, cctx)) yield c;
          if (ev.kind === 'content_delta') agg.content += ev.content;
          if (ev.kind === 'think_delta') agg.reasoning += ev.content;
          if (ev.kind === 'message_id') handle.run.parentMessageId = ev.id;
          if (ev.kind === 'usage' && ev.inputTokens > 0 && ev.outputTokens >= 0) {
            agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
          }
        }
        if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
          const parsed = parseToolCalls(agg.content);
          if (parsed) {
            agg.toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls';
            const toolChunk: ChatCompletionChunk = { ...cctx, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: parsed.calls }, finish_reason: 'tool_calls' }] };
            yield toolChunk;
          } else if (!hasToolTags(agg.content)) {
            // 模型未输出工具标签：合法（tool_choice:auto 可不调用），正常 stop
            agg.finishReason = agg.finishReason ?? 'stop';
          }
        }
        yield finalChunk(cctx, agg.finishReason ?? 'stop', agg.usage);
        // mirror 含 assistant 回复（同 finalize 的修复）：保证下一轮增量命中
        const mirrorMessages: Message[] = [...messages, { role: 'assistant', content: agg.content, ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}) }];
        self.d.mapper.commit(provider.id, handle.convId, mirrorMessages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId);
        done(true, self.d.now() - started);
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
