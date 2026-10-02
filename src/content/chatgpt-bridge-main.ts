/**
 * ChatGPT MAIN world 桥接脚本。
 *
 * 协议来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md + .superpowers/sdd/2026-10-01-chatgpt-provider-v1/task-3-brief。
 *
 * 职责（两条腿）：
 *  1. 出：document_start 时把 `window.fetch` 包一层。命中 `/backend-api/f/conversation`
 *     时旁路读 response body，按 splitFrames/parseFrame 拆 SSE 帧，每帧 postMessage 出去
 *     （kind='frame'），终止时 kind='done'，resume_conversation_token 帧携带 kind='conversation'。
 *  2. 入：监听 window 'message'，收到 `__deepApiChatGPT: 'send'` 后驱动 ChatGPT 网页：
 *     切到目标会话（如需）→ 等 composer（#prompt-textarea，绝不退回 fallback textarea）→
 *     填词 → 等 send 按钮（先填后等，避免鸡生蛋） → 点击 → fetch 钩子接管读流。
 *
 * 三个真实踩过的坑（brief 反复强调）：
 *  A. **document_start 挂 fetch**——bundle 在模块初始化时已取走 window.fetch 引用，
 *     运行期 patch 拦不到任何请求。本模块顶层 IIFE 立即执行 install()，fetch 同步被替换。
 *  B. **composer 必须是 #prompt-textarea**——未水合时输入框是 wcDTda_fallbackTextarea，
 *     往里填词点 send 只触发 GET /?prompt-textarea=... 导航，根本不是发送。
 *  C. **不能用 send 按钮存在与否判断就绪**——它要等有文字才出现，与 composer 就绪是鸡生蛋。
 *     正确顺序：等 composer → 填词 → 等 send 按钮 → 点击（findComposer 与 findSendButton
 *     各自独立 poll，没有互相等待）。
 *
 * URL 过滤（另一个易错点）：/backend-api/f/conversation 必须**严格 pathname 等于**，
 * /f/conversation/prepare 不是目标——上一轮用无边界匹配误把会话列表当流式请求。
 *
 * 跨导航恢复：handleSend 入口先 savePendingSend 到 sessionStorage（同源导航保留），
 * location.assign 之后新文档加载、脚本重注入，install() 入口读 loadPendingSend 继续。
 * 这条契约保证「等页面重新水合」期间指令不丢。
 */
import { splitFrames, parseFrame } from '../shared/chatgpt-sse';
import type { SseFrame } from '../shared/chatgpt-sse';

// ===== 常量（manifest matches 与 selector；集中在一处便于审查）=====
/** ChatGPT 后端真实流式端点——与 /backend-api/f/conversation/prepare、/backend-api/sentinel/* 严格区分。 */
const TARGET_PATHNAME = '/backend-api/f/conversation';
/** Composer 真实选择器：contenteditable div。页面未水合时此元素不存在——宁可超时也不退回 fallback。 */
const COMPOSER_SELECTOR = '#prompt-textarea';
/** send 按钮选择器：实测 data-testid + aria-label 双候选，谁先命中用谁。 */
const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
];
/** Composer / send 按钮默认超时（ms）。Composer 30s 等水合、send 按钮 10s（已填词后应该秒出）。 */
const COMPOSER_TIMEOUT_MS = 30_000;
const SEND_BUTTON_TIMEOUT_MS = 10_000;
/** Composer / send 按钮轮询间隔（ms）。100ms 是肉眼无感的最低开销。 */
const POLL_INTERVAL_MS = 100;
/** sessionStorage 键——同源导航保留。 */
const PENDING_SEND_KEY = '__deepApiChatGPT.pendingSend.v1';

/** window 事件契约：发出 */
interface OutgoingFrameMsg {
  __deepApiChatGPT: true;
  kind: 'frame';
  requestId: string;
  event: string | null;
  data: string;
}
interface OutgoingConversationMsg {
  __deepApiChatGPT: true;
  kind: 'conversation';
  requestId: string;
  conversationId: string;
}
interface OutgoingDoneMsg {
  __deepApiChatGPT: true;
  kind: 'done';
  requestId: string;
}
interface OutgoingErrorMsg {
  __deepApiChatGPT: true;
  kind: 'error';
  requestId: string;
  message: string;
}
interface OutgoingStreamStartMsg {
  __deepApiChatGPT: true;
  kind: 'stream-start';
  requestId: string;
}

/** window 事件契约：接收 */
export interface PendingSend {
  requestId: string;
  text: string;
  /** null = 当前在「新会话」状态；非 null = 切到 /c/<id> 后再发。 */
  conversationId: string | null;
}

/** 流 tap 状态——按 (requestId) 隔离。当前实现单 active，可拓展为 Map。 */
interface TapState {
  buffer: string;
  conversationId: string | null;
}

// ===== 1. URL 过滤（最易写错：必须严格 pathname 等于）=====

/**
 * 判断 fetch 的输入是否就是流式端点 /backend-api/f/conversation。
 * 关键：用 `new URL(...).pathname` 严格相等；/f/conversation/prepare 等带尾巴的会直接被拒。
 * 输入可以是相对路径（'/backend-api/f/conversation'）或绝对 URL（'https://chatgpt.com/...'）。
 */
export function isTargetConversationUrl(rawUrl: string): boolean {
  let pathname: string;
  try {
    // 用 chatgpt.com 作 base：fetch 调用既可能是相对也可能是绝对；new URL 都会归一化 pathname
    const u = new URL(rawUrl, 'https://chatgpt.com/');
    pathname = u.pathname;
  } catch {
    return false;
  }
  // 严格 pathname 相等——endsWith/startWith 都会让 /prepare 等溜进来
  return pathname === TARGET_PATHNAME;
}

// ===== 2. Composer 探测（关键：不退回 fallback）=====

/**
 * 同步探测 composer 元素是否存在。返回 null 时意味着页面未水合或 DOM 结构异常——
 * 调用方应进入轮询/超时路径，**绝不能**用 fallback textarea 顶替（详见文件头坑 B）。
 */
export function findComposer(doc: Document): Element | null {
  return doc.querySelector(COMPOSER_SELECTOR);
}

/**
 * 轮询等待 composer 出现；超时返回 null（不抛、不退化到 fallback）。
 */
export function waitForComposer(doc: Document, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      const el = findComposer(doc);
      if (el !== null) { resolve(el); return; }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

/**
 * 把 text 填入 composer：focus → 清空（若有）→ 写入 → 派发 beforeinput + input。
 *
 * 为什么手动派发事件：ChatGPT 的 React 应用监听 contenteditable 上的 input 事件触发受控更新，
 * 直接改 innerText 不会让 React 看到「文本变了」。先派发 deleteContent 清空，再派发
 * insertText 写入，与用户键入序列同形，React 的合成事件系统会正确更新 state。
 *
 * inputType 字段也填上：ChatGPT 可能用它来区分「程序粘贴」与「用户键入」，填错会被反自动化拦。
 */
export function fillComposer(el: Element, text: string): void {
  const ce = el as HTMLElement;
  ce.focus();
  // 用 textContent 写入而不是 innerText：
  //  - jsdom 的 innerText setter 不可靠（不更新 textContent）——测试用 jsdom 必须 textContent
  //  - 真实浏览器里 textContent 写入也会触发 DOM 变化，React 监听的是我们随后派发的 input 事件
  //  - textContent 不做隐式换行/首尾空白处理，可预测（innerText 会按渲染态改写）
  // 已有内容时先清空（dispatch deleteContent 让 React 看到空变化）
  if ((ce.textContent ?? '') !== '') {
    ce.textContent = '';
    ce.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'deleteContent' }));
    ce.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }
  // 写入新文本
  ce.textContent = text;
  ce.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
  ce.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

// ===== 3. send 按钮探测（先填后等，避免鸡生蛋）=====

/** 同步探测 send 按钮：data-testid 与 aria-label 双候选，谁先匹配用谁。 */
export function findSendButton(doc: Document): Element | null {
  for (const sel of SEND_BUTTON_SELECTORS) {
    const btn = doc.querySelector(sel);
    if (btn !== null) return btn;
  }
  return null;
}

/** 轮询等待 send 按钮；超时返回 null。 */
export function waitForSendButton(doc: Document, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      const el = findSendButton(doc);
      if (el !== null) { resolve(el); return; }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

// ===== 4. 流帧终止判定 + conversationId 提取 =====

/** 终止帧：[DONE] 哨兵或 message_stream_complete 信封。 */
export function isTerminalFrame(frame: SseFrame): boolean {
  if (frame.data === '[DONE]') return true;
  // message_stream_complete 帧：type 字段等于此值
  try {
    const parsed = JSON.parse(frame.data) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const t = (parsed as { type?: unknown }).type;
      if (t === 'message_stream_complete') return true;
    }
  } catch {
    /* 非 JSON 不是终止 */
  }
  return false;
}

/** 解析 resume_conversation_token 帧的 conversation_id；非此类帧返回 null。 */
export function parseResumeConversationToken(frame: SseFrame): string | null {
  try {
    const parsed = JSON.parse(frame.data) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as { type?: unknown; conversation_id?: unknown };
    if (obj.type !== 'resume_conversation_token') return null;
    if (typeof obj.conversation_id !== 'string') return null;
    return obj.conversation_id;
  } catch {
    return null;
  }
}

/**
 * 把一段输入字符串喂给流 tap：splitFrames + parseFrame + 终止检测 + conversationId 捕获。
 * 返回的 frames 是要 post 给 relay 的全部 SSE 帧（event/data 形态）；done=true 时上游应停止读 body。
 * state 跨调用持久化（buffer 残留 + conversationId 累计）。
 */
export function processTapBuffer(
  state: TapState,
  incoming: string,
): { frames: Array<{ event: string | null; data: string }>; done: boolean } {
  state.buffer += incoming;
  const { frames: rawFrames, rest } = splitFrames(state.buffer);
  state.buffer = rest;
  const out: Array<{ event: string | null; data: string }> = [];
  let done = false;
  for (const raw of rawFrames) {
    const f = parseFrame(raw);
    if (f === null) continue;
    // conversationId 在任意位置出现都捕获——resume_conversation_token 在流早期，但留口子防变体
    const cid = parseResumeConversationToken(f);
    if (cid !== null) state.conversationId = cid;
    out.push({ event: f.event, data: f.data });
    if (isTerminalFrame(f)) { done = true; break; }
  }
  return { frames: out, done };
}

// ===== 5. sessionStorage 跨导航恢复 =====

/** 把待发指令写到 sessionStorage；location.assign 跨同源导航后，新文档的脚本会取回。 */
export function savePendingSend(p: PendingSend): void {
  try {
    sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify(p));
  } catch {
    /* sessionStorage 满 / 禁用——降级：只走内存路径，导航后丢；不致命 */
  }
}

/** 从 sessionStorage 取回待发指令；不存在或畸形返回 null。 */
export function loadPendingSend(): PendingSend | null {
  const raw = sessionStorage.getItem(PENDING_SEND_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.requestId !== 'string') return null;
    if (typeof obj.text !== 'string') return null;
    const cid = obj.conversationId;
    return {
      requestId: obj.requestId,
      text: obj.text,
      conversationId: typeof cid === 'string' ? cid : null,
    };
  } catch {
    return null;
  }
}

/** 流成功结束 / 硬错误时清掉待发指令，避免下次导航误复活。 */
export function clearPendingSend(): void {
  try {
    sessionStorage.removeItem(PENDING_SEND_KEY);
  } catch {
    /* ignore */
  }
}

// ===== 6. fetch 钩子（document_start 立即生效）=====

/** 当前活跃请求 id——handleSend 进入时设、tap 完成时清；单 active 模型简化并发。 */
let activeRequestId: string | null = null;
/** 当前活跃 tap 状态——按 activeRequestId 切换；多个流并发时换成 Map<string, TapState>。 */
let activeTapState: TapState | null = null;

/** 把消息 post 给 window（relay 转发到 SW）。 */
function postOutgoing(msg: { __deepApiChatGPT: true } & Record<string, unknown>): void {
  try {
    window.postMessage(msg, '*');
  } catch {
    /* ignore */
  }
}

/** 旁路读 response body 并把帧发出去——直到 done 或流结束。 */
async function tapConversationResponse(response: Response, requestId: string): Promise<void> {
  // response.body 只读一次；必须 clone 出独立流，不影响原 page 的消费者
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = response.clone().body!.getReader();
  } catch {
    return;
  }
  const decoder = new TextDecoder();
  let doneSeen = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        const text = decoder.decode(value, { stream: true });
        if (activeRequestId === requestId && activeTapState !== null) {
          const r = processTapBuffer(activeTapState, text);
          for (const f of r.frames) {
            postOutgoing({ __deepApiChatGPT: true, kind: 'frame', requestId, event: f.event, data: f.data } satisfies OutgoingFrameMsg);
          }
          // conversationId 一旦捕获就发出（流早期通常就拿到，但留口子防变体帧序）
          if (activeTapState.conversationId !== null) {
            postOutgoing({ __deepApiChatGPT: true, kind: 'conversation', requestId, conversationId: activeTapState.conversationId } satisfies OutgoingConversationMsg);
          }
          if (r.done) { doneSeen = true; break; }
        }
      }
      if (done) break;
    }
    // trailing flush：处理 stream 关闭时 buffer 残留的尾巴
    if (!doneSeen && activeRequestId === requestId && activeTapState !== null) {
      const tail = decoder.decode();
      if (tail.length > 0) {
        const r = processTapBuffer(activeTapState, tail);
        for (const f of r.frames) {
          postOutgoing({ __deepApiChatGPT: true, kind: 'frame', requestId, event: f.event, data: f.data } satisfies OutgoingFrameMsg);
        }
        if (activeTapState.conversationId !== null) {
          postOutgoing({ __deepApiChatGPT: true, kind: 'conversation', requestId, conversationId: activeTapState.conversationId } satisfies OutgoingConversationMsg);
        }
      }
    }
  } catch {
    /* stream 读失败——错误信息已通过 stream 自然结束时的 [DONE] 告知 */
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    if (doneSeen) {
      postOutgoing({ __deepApiChatGPT: true, kind: 'done', requestId } satisfies OutgoingDoneMsg);
      // 流成功结束：清掉 sessionStorage 待发指令（仅当还是当前这次请求时）
      if (activeRequestId === requestId) {
        const pending = loadPendingSend();
        if (pending !== null && pending.requestId === requestId) clearPendingSend();
        activeRequestId = null;
        activeTapState = null;
      }
    }
  }
}

/** 包装 window.fetch：命中流式端点时启动 tap。document_start 同步替换——运行期再换就拦不到了。 */
function patchFetch(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
    const isTarget = isTargetConversationUrl(raw);
    const promise = origFetch(input, init);
    if (!isTarget) return promise;
    promise.then(
      (resp) => { void tapConversationResponse(resp, activeRequestId ?? ''); },
      () => { /* fetch 失败：不发任何事件，由 SW 端兜底 */ },
    ).catch(() => undefined);
    return promise;
  };
}

// ===== 7. send 指令处理 =====
/** 单飞守卫：同时只有一个 send 在执行（导航后脚本重新注入时也只接管一次）。 */
let inflightSend = false;

async function handleSend(p: PendingSend): Promise<void> {
  if (inflightSend) return;
  inflightSend = true;
  // 进入即存：location.assign 后新文档会读回继续——同时防中途崩溃丢指令
  savePendingSend(p);
  activeRequestId = p.requestId;
  activeTapState = { buffer: '', conversationId: null };
  try {
    // 会话切换：非 null 时若不在目标会话，先导航——脚本会重注入
    if (p.conversationId !== null && !location.pathname.startsWith('/c/' + p.conversationId)) {
      location.assign('/c/' + p.conversationId);
      // 不清 inflightSend——新文档接管时会 reset
      // 也不发任何 outgoing——等新脚本接管
      return;
    }
    // 等 composer（绝不用 fallback）
    const composer = await waitForComposer(document, COMPOSER_TIMEOUT_MS);
    if (composer === null) {
      postOutgoing({ __deepApiChatGPT: true, kind: 'error', requestId: p.requestId, message: 'composer not found after ' + COMPOSER_TIMEOUT_MS + 'ms' } satisfies OutgoingErrorMsg);
      clearPendingSend();
      activeRequestId = null;
      activeTapState = null;
      return;
    }
    // 先填词
    fillComposer(composer, p.text);
    // 再等 send 按钮（先填后等，避免鸡生蛋）
    const btn = await waitForSendButton(document, SEND_BUTTON_TIMEOUT_MS);
    if (btn === null) {
      postOutgoing({ __deepApiChatGPT: true, kind: 'error', requestId: p.requestId, message: 'send button not found after ' + SEND_BUTTON_TIMEOUT_MS + 'ms' } satisfies OutgoingErrorMsg);
      clearPendingSend();
      activeRequestId = null;
      activeTapState = null;
      return;
    }
    // 点击——fetch 钩子会立即命中并接管读流
    (btn as HTMLElement).click();
    // stream-start 提示：consumer 知道 fetch 已发出；真正的 frame 会按 fetch 流到达
    postOutgoing({ __deepApiChatGPT: true, kind: 'stream-start', requestId: p.requestId } satisfies OutgoingStreamStartMsg);
  } catch (e) {
    postOutgoing({ __deepApiChatGPT: true, kind: 'error', requestId: p.requestId, message: 'handleSend: ' + String(e) } satisfies OutgoingErrorMsg);
    clearPendingSend();
    activeRequestId = null;
    activeTapState = null;
  } finally {
    inflightSend = false;
  }
}

// ===== 8. window.message listener =====

function installMessageListener(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    // brief 事件契约：来自 relay（self window）的 send 指令
    // 防 cross-origin 噪音：仅当 source 是 self window 时接收
    if (ev.source !== null && ev.source !== window) return;
    const data = ev.data as { __deepApiChatGPT?: unknown } | undefined;
    if (typeof data !== 'object' || data === null) return;
    if (data.__deepApiChatGPT !== 'send') return;
    const msg = ev.data as { requestId?: unknown; text?: unknown; conversationId?: unknown };
    if (typeof msg.requestId !== 'string' || typeof msg.text !== 'string') return;
    const cid = typeof msg.conversationId === 'string' ? msg.conversationId : null;
    void handleSend({ requestId: msg.requestId, text: msg.text, conversationId: cid });
  });
}

// ===== 9. 跨导航恢复：模块加载时取回待发指令 =====

function resumePendingSend(): void {
  const pending = loadPendingSend();
  if (pending === null) return;
  // 避免与 in-flight（若有）冲突——单飞守卫会拦第二次
  void handleSend(pending);
}

// ===== 10. install：所有副作用集中入口（测试可重复调用、幂等）=====

/** 模块级守卫：install 多次调用副作用只装一次。 */
declare global { interface Window { __deepApiChatGPTBridgeInstalled?: boolean } }

/** 主入口：document_start 同步调用。fetch 替换 + 装 message listener + 取回跨导航指令。 */
export function install(): void {
  if (typeof window === 'undefined') return;
  if (window.__deepApiChatGPTBridgeInstalled === true) return;
  window.__deepApiChatGPTBridgeInstalled = true;
  patchFetch();
  installMessageListener();
  resumePendingSend();
  console.log('[deep.api chatgpt-bridge-main] installed on', location.host, 'at', new Date().toISOString());
}

/** 测试用：暴露 install 标志位的当前状态。 */
export function _peekInstall(): boolean {
  return typeof window !== 'undefined' && window.__deepApiChatGPTBridgeInstalled === true;
}

// ===== 11. 顶层 IIFE：document_start 时立即执行 install =====
// document_start 同步执行——这是 fetch patch 必须在运行期前装上的唯一机会
// （详见文件头坑 A）。测试环境下也跑（测试 install() 副作用），install 内部的守卫保证幂等。
install();
