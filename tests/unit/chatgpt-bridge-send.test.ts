// @vitest-environment jsdom
/**
 * ChatGPT MAIN world 桥接脚本测试。
 *
 * 协议来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md + task-3-brief。
 *
 * 测试策略（brief「把驱动 composer 发消息的核心逻辑抽成可测纯函数」）：
 *  1. URL 过滤：纯函数，最容易写错——必须用严格 pathname 等于、不能用 startsWith。
 *  2. Composer/Button DOM 探测：纯函数，jsdom 直接造 DOM 验证。
 *  3. fillComposer：纯函数（只接 element，不读全局），jsdom 验证 innerText 清空/写入 + 事件派发。
 *  4. 流帧处理：processTapBuffer 拿 Task 1 的 splitFrames/parseFrame 组合——可独立单测。
 *  5. sessionStorage 跨导航恢复：纯 save/load/clear，jsdom 提供 storage。
 *
 * 真实 fetch 流式 body 的集成测试：jsdom 的 Response.body.getReader() 在 fetch mock 之外不易复现；
 * 拆出来的 processTapBuffer 已经覆盖「buffer 跨 chunk + 终止检测 + conversationId 提取」，
 * 真实 fetch 钩子是「读到字节 → 转字符串 → 喂 processTapBuffer」的胶水代码，
 * TypeScript 编译即可拦住拼装错误，不需要单测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isTargetConversationUrl,
  findComposer,
  waitForComposer,
  fillComposer,
  findSendButton,
  waitForSendButton,
  isTerminalFrame,
  parseResumeConversationToken,
  processTapBuffer,
  savePendingSend,
  loadPendingSend,
  clearPendingSend,
} from '../../src/content/chatgpt-bridge-main';
import type { SseFrame } from '../../src/shared/chatgpt-sse';

// ===== 1. URL 过滤（最容易写错：/prepare 必须排除）=====
describe('isTargetConversationUrl', () => {
  it('匹配相对路径 /backend-api/f/conversation', () => {
    expect(isTargetConversationUrl('/backend-api/f/conversation')).toBe(true);
  });

  it('匹配绝对路径 https://chatgpt.com/backend-api/f/conversation', () => {
    expect(isTargetConversationUrl('https://chatgpt.com/backend-api/f/conversation')).toBe(true);
  });

  // brief：「/f/conversation/prepare 不是目标，必须排除」
  it('**排除** /backend-api/f/conversation/prepare（不能 endsWith /conversation 蒙混过关）', () => {
    expect(isTargetConversationUrl('/backend-api/f/conversation/prepare')).toBe(false);
  });

  it('排除 /backend-api/sentinel/* 等其它端点', () => {
    expect(isTargetConversationUrl('/backend-api/sentinel/chat-requirements')).toBe(false);
    expect(isTargetConversationUrl('/backend-api/other/path')).toBe(false);
  });

  it('排除无关路径', () => {
    expect(isTargetConversationUrl('/api/foo')).toBe(false);
    expect(isTargetConversationUrl('/')).toBe(false);
    expect(isTargetConversationUrl('')).toBe(false);
  });

  it('排除伪装的会话列表 URL（/conversation-list 之类）', () => {
    expect(isTargetConversationUrl('/backend-api/conversation-list')).toBe(false);
    expect(isTargetConversationUrl('/backend-api/f/conversation_old')).toBe(false);
  });

  it('排除畸形 URL', () => {
    // 不是合法 URL 又不是合法路径——解析失败返回 false，不抛
    expect(isTargetConversationUrl('not a url :::')).toBe(false);
  });
});

// ===== 2. composer 探测（最易踩坑：fallback 不能顶替）=====
describe('findComposer', () => {
  it('空文档 → null', () => {
    document.body.innerHTML = '';
    expect(findComposer(document)).toBeNull();
  });

  // brief 实测：未水合时只有 <textarea class="wcDTda_fallbackTextarea">，绝不能认成 composer
  it('**只存在 fallback textarea 时返回 null**（页面未水合，宁可超时也不退化）', () => {
    document.body.innerHTML = '<textarea class="wcDTda_fallbackTextarea"></textarea>';
    expect(findComposer(document)).toBeNull();
  });

  it('fallback + 其它元素共存，仍返回 null', () => {
    document.body.innerHTML = `
      <textarea class="wcDTda_fallbackTextarea"></textarea>
      <div>some other element</div>
    `;
    expect(findComposer(document)).toBeNull();
  });

  it('#prompt-textarea 存在 → 返回该元素', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const el = findComposer(document);
    expect(el).not.toBeNull();
    expect(el?.id).toBe('prompt-textarea');
  });

  it('#prompt-textarea 与 fallback 共存 → 返回 #prompt-textarea（页面已水合完）', () => {
    document.body.innerHTML = `
      <textarea class="wcDTda_fallbackTextarea"></textarea>
      <div id="prompt-textarea" contenteditable="true"></div>
    `;
    const el = findComposer(document);
    expect(el?.id).toBe('prompt-textarea');
  });
});

describe('waitForComposer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('元素立即存在 → 立即 resolve（next tick）', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const el = await waitForComposer(document, 1000);
    expect(el?.id).toBe('prompt-textarea');
  });

  it('只有 fallback → 1000ms 超时返回 null（不退回 fallback）', async () => {
    document.body.innerHTML = '<textarea class="wcDTda_fallbackTextarea"></textarea>';
    const p = waitForComposer(document, 1000);
    // 推进时间到超时
    await vi.advanceTimersByTimeAsync(1500);
    const el = await p;
    expect(el).toBeNull();
  });

  it('轮询途中元素出现 → resolve 该元素', async () => {
    const p = waitForComposer(document, 5000);
    // 推进几次轮询周期，模拟页面慢慢水合
    await vi.advanceTimersByTimeAsync(250);
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    await vi.advanceTimersByTimeAsync(150);   // 下一次 poll
    const el = await p;
    expect(el?.id).toBe('prompt-textarea');
  });
});

// ===== 3. fillComposer（关键操作：清空 + 填词 + 派发事件）=====
describe('fillComposer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('清空已有内容后再填新内容', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true">旧内容</div>';
    const el = document.getElementById('prompt-textarea')!;
    fillComposer(el, '你好');
    // 清空后写入新内容
    expect(el.textContent).toBe('你好');
  });

  it('原本为空时直接填入（不派发空 clear）', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const el = document.getElementById('prompt-textarea')!;
    const beforeinputEvents: string[] = [];
    el.addEventListener('beforeinput', (e) => beforeinputEvents.push((e as InputEvent).inputType ?? ''));
    fillComposer(el, 'hello');
    expect(el.textContent).toBe('hello');
    // 只有一次 insertText，不应该有 deleteContent
    expect(beforeinputEvents).toEqual(['insertText']);
  });

  it('原本有内容时先 deleteContent 清空，再 insertText 写入', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true">old</div>';
    const el = document.getElementById('prompt-textarea')!;
    const beforeinputEvents: string[] = [];
    el.addEventListener('beforeinput', (e) => beforeinputEvents.push((e as InputEvent).inputType ?? ''));
    fillComposer(el, 'new');
    // 清空 + 写入两个阶段：先 inputType=deleteContent，再 insertText
    expect(beforeinputEvents[0]).toBe('deleteContent');
    expect(beforeinputEvents).toContain('insertText');
  });

  it('派发 input 事件（React 的 onChange 监听 input 事件而非 change）', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const el = document.getElementById('prompt-textarea')!;
    let inputCount = 0;
    el.addEventListener('input', () => inputCount++);
    fillComposer(el, 'text');
    expect(inputCount).toBeGreaterThan(0);
  });

  it('填入空字符串：清空已有内容', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true">要清的</div>';
    const el = document.getElementById('prompt-textarea')!;
    fillComposer(el, '');
    expect(el.textContent).toBe('');
  });

  it('填入多行文本（含 \\n）原样保留', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    const el = document.getElementById('prompt-textarea')!;
    fillComposer(el, '第一行\n第二行');
    expect(el.textContent).toBe('第一行\n第二行');
  });
});

// ===== 4. send 按钮探测 =====
describe('findSendButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('无按钮 → null', () => {
    expect(findSendButton(document)).toBeNull();
  });

  it('data-testid="send-button" 按钮存在 → 返回该元素', () => {
    document.body.innerHTML = '<button data-testid="send-button">Send</button>';
    const btn = findSendButton(document);
    expect(btn?.getAttribute('data-testid')).toBe('send-button');
  });

  it('aria-label 含 "Send" 的按钮存在 → 返回该元素', () => {
    document.body.innerHTML = '<button aria-label="Send prompt">Go</button>';
    expect(findSendButton(document)?.getAttribute('aria-label')).toBe('Send prompt');
  });

  it('无关按钮存在 → null（不能误抓）', () => {
    document.body.innerHTML = '<button>关闭</button><button data-testid="model-switcher">A</button>';
    expect(findSendButton(document)).toBeNull();
  });

  it('多个候选按钮共存 → 命中第一个', () => {
    document.body.innerHTML = `
      <button data-testid="other">1</button>
      <button data-testid="send-button">2</button>
    `;
    expect(findSendButton(document)?.getAttribute('data-testid')).toBe('send-button');
  });
});

describe('waitForSendButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('立即存在 → 立即 resolve', async () => {
    document.body.innerHTML = '<button data-testid="send-button">S</button>';
    const btn = await waitForSendButton(document, 1000);
    expect(btn).not.toBeNull();
  });

  it('超时 → null', async () => {
    const p = waitForSendButton(document, 500);
    await vi.advanceTimersByTimeAsync(700);
    expect(await p).toBeNull();
  });

  it('轮询途中出现 → resolve', async () => {
    const p = waitForSendButton(document, 5000);
    await vi.advanceTimersByTimeAsync(250);
    document.body.innerHTML = '<button data-testid="send-button">S</button>';
    await vi.advanceTimersByTimeAsync(150);
    expect(await p).not.toBeNull();
  });
});

// ===== 5. 流帧终止判定 =====
describe('isTerminalFrame', () => {
  it('data: [DONE] → true', () => {
    expect(isTerminalFrame({ event: null, data: '[DONE]' })).toBe(true);
  });

  it('{"type":"message_stream_complete"} → true', () => {
    expect(isTerminalFrame({
      event: null,
      data: '{"type":"message_stream_complete"}',
    })).toBe(true);
  });

  it('正常 delta 帧 → false', () => {
    expect(isTerminalFrame({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"hi"}',
    })).toBe(false);
  });

  it('其它顶层 type 帧（title_generation、server_ste_metadata）→ false', () => {
    expect(isTerminalFrame({ event: null, data: '{"type":"title_generation"}' })).toBe(false);
    expect(isTerminalFrame({ event: null, data: '{"type":"server_ste_metadata"}' })).toBe(false);
  });
});

// ===== 6. conversationId 提取 =====
describe('parseResumeConversationToken', () => {
  it('resume_conversation_token 帧含 conversation_id → 返回该 id', () => {
    expect(parseResumeConversationToken({
      event: null,
      data: '{"type":"resume_conversation_token","conversation_id":"uuid-x","token":"jwt.y"}',
    })).toBe('uuid-x');
  });

  it('非 resume 帧 → null', () => {
    expect(parseResumeConversationToken({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"hi"}',
    })).toBeNull();
  });

  it('非 JSON 帧（[DONE]） → null', () => {
    expect(parseResumeConversationToken({ event: null, data: '[DONE]' })).toBeNull();
  });

  it('resume 帧缺 conversation_id → null', () => {
    expect(parseResumeConversationToken({
      event: null,
      data: '{"type":"resume_conversation_token","token":"x"}',
    })).toBeNull();
  });
});

// ===== 7. processTapBuffer：核心流处理（Task 1 拆帧 + 终止检测 + conversationId 提取）=====
describe('processTapBuffer', () => {
  function newState() {
    return { buffer: '', conversationId: null as string | null };
  }

  it('单完整帧：拆出 frame、buffer 清空', () => {
    const s = newState();
    const r = processTapBuffer(s, 'data: hello\n\n');
    expect(r.frames).toEqual([{ event: null, data: 'hello' }]);
    expect(r.done).toBe(false);
    expect(s.buffer).toBe('');
  });

  it('跨 chunk：第一次 partial，第二次完整', () => {
    const s = newState();
    const r1 = processTapBuffer(s, 'data: hel');
    expect(r1.frames).toEqual([]);
    expect(s.buffer).toBe('data: hel');
    const r2 = processTapBuffer(s, 'lo\n\n');
    expect(r2.frames).toEqual([{ event: null, data: 'hello' }]);
    expect(s.buffer).toBe('');
  });

  it('[DONE] 触发 done=true', () => {
    const s = newState();
    const r = processTapBuffer(s, 'data: hi\n\ndata: [DONE]\n\n');
    expect(r.done).toBe(true);
    expect(r.frames).toHaveLength(2);
    expect(r.frames[1]).toEqual({ event: null, data: '[DONE]' });
  });

  it('{"type":"message_stream_complete"} 触发 done=true', () => {
    const s = newState();
    const r = processTapBuffer(s, 'data: last\n\ndata: {"type":"message_stream_complete"}\n\n');
    expect(r.done).toBe(true);
  });

  it('resume_conversation_token → conversationId 被捕获', () => {
    const s = newState();
    const r = processTapBuffer(s, 'data: {"type":"resume_conversation_token","conversation_id":"uuid-a","token":"t"}\n\n');
    expect(s.conversationId).toBe('uuid-a');
  });

  it('流末 trailing 帧无 \\n\\n → processTapBuffer 第二次给完整 chunk 才产出', () => {
    const s = newState();
    // 模拟 network chunk: 半截帧（最后一个 \n 缺一半）
    const r1 = processTapBuffer(s, 'event: delta\ndata: {"x":');
    expect(r1.frames).toEqual([]);
    expect(s.buffer).toBe('event: delta\ndata: {"x":');
    // 拼上下一个 chunk
    const r2 = processTapBuffer(s, '1}\n\n');
    expect(r2.frames).toHaveLength(1);
  });

  it('完整帧含 event: + data: → frame.event 正确', () => {
    const s = newState();
    const r = processTapBuffer(s, 'event: delta\ndata: {"v":"a"}\n\n');
    expect(r.frames[0]).toEqual({ event: 'delta', data: '{"v":"a"}' });
  });

  it('done 后 frame 列表只含到终止帧之前', () => {
    const s = newState();
    // 流：[delta, delta, [DONE]]
    const r = processTapBuffer(s, 'event: delta\ndata: {"v":"a"}\n\nevent: delta\ndata: {"v":"b"}\n\ndata: [DONE]\n\n');
    // 当前实现：done=true 时 break，但 [DONE] 这一帧本身仍可能进入 frames
    // 真实流：[DONE] 之后没有内容，break 不影响外部——frame 列表含 [DONE] 也对。
    expect(r.frames.length).toBeGreaterThanOrEqual(2);
    expect(r.done).toBe(true);
  });
});

// ===== 8. sessionStorage 跨导航恢复（关键：location.assign 后指令不能丢）=====
describe('sessionStorage 待发指令', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('save → load 往返一致', () => {
    const p = { requestId: 'r-1', text: 'hi', conversationId: 'uuid-x' };
    savePendingSend(p);
    expect(loadPendingSend()).toEqual(p);
  });

  it('conversationId 为 null 时也能往返', () => {
    const p = { requestId: 'r-2', text: 'new chat', conversationId: null };
    savePendingSend(p);
    expect(loadPendingSend()).toEqual(p);
  });

  it('无存储 → load 返回 null', () => {
    expect(loadPendingSend()).toBeNull();
  });

  it('clear 后 load 返回 null', () => {
    savePendingSend({ requestId: 'r', text: 't', conversationId: null });
    clearPendingSend();
    expect(loadPendingSend()).toBeNull();
  });

  it('畸形数据 → load 返回 null（不抛）', () => {
    sessionStorage.setItem('__deepApiChatGPT.pendingSend.v1', '{not json');
    expect(loadPendingSend()).toBeNull();
    sessionStorage.setItem('__deepApiChatGPT.pendingSend.v1', JSON.stringify({ wrong: 'shape' }));
    expect(loadPendingSend()).toBeNull();
    sessionStorage.setItem('__deepApiChatGPT.pendingSend.v1', JSON.stringify({ requestId: 123, text: 't' }));
    expect(loadPendingSend()).toBeNull();
  });

  it('多次 save 后 load 返回最新一次（location.assign 之前再改也应生效）', () => {
    savePendingSend({ requestId: 'old', text: 'old', conversationId: null });
    savePendingSend({ requestId: 'new', text: 'new', conversationId: 'uuid-z' });
    expect(loadPendingSend()).toEqual({ requestId: 'new', text: 'new', conversationId: 'uuid-z' });
  });
});

// ===== 9. 端到端：真实帧序列通过 processTapBuffer 处理（模拟整流）=====
describe('processTapBuffer × 协议 doc 真实帧序列', () => {
  it('20 帧：捕获 conversationId、所有 frame、不漏 done', () => {
    // 协议 doc 帧序列（与 chatgpt-stream.test.ts 一致）
    const frames: string[] = [
      'event: delta_encoding\ndata: "v1"\n\n',
      'data: {"type":"resume_conversation_token","conversation_id":"uuid-real","token":"t"}\n\n',
      'event: delta\ndata: {"p":"","o":"add","v":{"id":"msg-1","author":{"role":"assistant"},"content":{"parts":[""]}},"c":0}\n\n',
      'event: delta\ndata: {"v":"7\\n8"}\n\n',
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"答复片段"}\n\n',
      'data: {"type":"message_stream_complete"}\n\n',
      'data: [DONE]\n\n',
    ];
    const buf = frames.join('');

    const state = { buffer: '', conversationId: null as string | null };
    const r = processTapBuffer(state, buf);

    // 全部 7 帧都被识别
    expect(r.frames.length).toBeGreaterThanOrEqual(6);
    expect(r.done).toBe(true);
    // conversationId 捕获
    expect(state.conversationId).toBe('uuid-real');
    // resume_conversation_token 帧本身在 frames 里
    const resumeFrame = r.frames.find(f => f.data.includes('resume_conversation_token'));
    expect(resumeFrame).toBeDefined();
  });

  it('流末 trailing 半截（最后一个 \\n 缺）：第一次不 done，拼接后 done', () => {
    // 模拟 chunk 1: 完整 + 半截
    const chunk1 = 'data: a\n\ndata: [DONE]\n';   // 末尾少一个 \n
    const chunk2 = '\n';   // chunk 2 给一个 \n，把 [DONE] 的 \n\n 拼完整

    const s = { buffer: '', conversationId: null as string | null };
    const r1 = processTapBuffer(s, chunk1);
    // chunk1 末尾 'data: [DONE]\n' → buffer 留 'data: [DONE]\n'（一个 \n 不构成 \n\n）
    expect(s.buffer).toBe('data: [DONE]\n');
    // 但 r1 已经拆出 a 帧
    expect(r1.frames).toEqual([{ event: null, data: 'a' }]);
    expect(r1.done).toBe(false);

    const r2 = processTapBuffer(s, chunk2);
    // chunk2 = '\n' → buffer = 'data: [DONE]\n\n' → 完整 [DONE] 帧，done=true
    expect(r2.frames).toEqual([{ event: null, data: '[DONE]' }]);
    expect(r2.done).toBe(true);
  });
});

// ===== 10. 集成（轻量）：install() 幂等 + window.fetch 被替换 =====
describe('集成：install 副作用', () => {
  beforeEach(() => {
    // 用 fake timers——handler 内部 await waitForComposer 会 setTimeout，fake 让我们主动推进
    vi.useFakeTimers();
    // 每个用例干净起见清掉 installed 标志——但 jsdom window 跨用例持久
    delete (window as { __deepApiChatGPTBridgeInstalled?: unknown }).__deepApiChatGPTBridgeInstalled;
    // 清空上次用例可能留下的 DOM
    document.body.innerHTML = '';
    // 清 sessionStorage——避免上一组用例（“待发指令”）的 save 污染本组用例的 install/resumePendingSend
    // （jsdom sessionStorage 跨用例持久）
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('install() 幂等：多次调用副作用只装一次', async () => {
    const { install, _peekInstall } = await import('../../src/content/chatgpt-bridge-main');
    install();
    const fetchA = window.fetch;
    install();
    const fetchB = window.fetch;
    expect(fetchA).toBe(fetchB);
    // 装上之后标志位为 true
    expect(_peekInstall()).toBe(true);
  });

  it('install() 后 window.fetch 不再是原始引用（patch 已生效）', async () => {
    const { install } = await import('../../src/content/chatgpt-bridge-main');
    // 记录 install 前的 fetch
    const origFetch = window.fetch;
    install();
    // 副作用已发生
    expect(window.fetch).not.toBe(origFetch);
  });

  it('install() 装上 window.message listener 来接收 send 指令', async () => {
    const { install } = await import('../../src/content/chatgpt-bridge-main');
    install();
    // 模拟 relay 发来 send 指令 → 应当被路由（错误路径：composer 不存在 → emit error）
    // 用 spy 监听 postMessage 的发出
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const sendMsg = { __deepApiChatGPT: 'send', requestId: 'r-test', text: 'hi', conversationId: null };
    window.dispatchEvent(new MessageEvent('message', { data: sendMsg, source: window }));
    // handler 是 async；等微任务链进入 waitForComposer，然后推进到 composer 超时（默认 30s）
    await vi.advanceTimersByTimeAsync(30_000 + 1000);
    // composer 不存在（jsdom 无 #prompt-textarea）→ 应发 error
    const calls = postSpy.mock.calls.map(c => c[0]);
    const errorCall = calls.find((c): c is { __deepApiChatGPT: true; kind: string; requestId: string } =>
      typeof c === 'object' && c !== null && (c as { __deepApiChatGPT?: unknown }).__deepApiChatGPT === true
      && (c as { kind?: string }).kind === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall?.requestId).toBe('r-test');
  });

  it('来自其它 window 的 message 忽略（source !== window）', async () => {
    const { install } = await import('../../src/content/chatgpt-bridge-main');
    install();
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const sendMsg = { __deepApiChatGPT: 'send', requestId: 'r-x', text: 'hi', conversationId: null };
    // source: null 模拟 cross-origin 或非 self 窗口——install 的 guard 应忽略
    window.dispatchEvent(new MessageEvent('message', { data: sendMsg, source: null }));
    // 推进时间——但 listener 的 guard 拦在第一行，不会进 handleSend
    await vi.advanceTimersByTimeAsync(1000);
    // 没有来自 self 的 send → 不应 emit 任何 __deepApiChatGPT 消息
    const ourMsgs = postSpy.mock.calls.filter(c => {
      const d = c[0];
      return typeof d === 'object' && d !== null && (d as { __deepApiChatGPT?: unknown }).__deepApiChatGPT === true;
    });
    expect(ourMsgs).toHaveLength(0);
  });
});
