// @vitest-environment jsdom
/**
 * 跨边界契约测试：**发送端真正产出的包** → **接收端真正的判定逻辑**。
 *
 * 为什么必须有这个文件（2026-10-04，fix/chatgpt-send-envelope-mismatch）：
 * send 指令横跨 SW（bridge-client）与页面 MAIN world（chatgpt-bridge-main）两个模块，
 * 两者不共享类型，tsc 拦不住形状漂移；而两侧各自的测试只断言自己那半边——
 * 发送端测试断言 `port.sent[0]` 长这样，接收端测试自己**手写**一个 send 包喂给 listener。
 * 结果：发送端发 `{__deepApiChatGPT: true, kind: 'send'}`、接收端判 `__deepApiChatGPT === 'send'`，
 * 两边测试全绿，真实链路上 send 被静默丢弃（ChatGPT 彻底不可用，用户侧只看到 120s 超时无报错）。
 * 本文件的职责就是消灭这类盲区：**只允许用发送端真实产出的对象**去喂接收端，不许手写。
 *
 * 覆盖四类：
 *  1. 发送端真产出的包 → 接收端谓词 isChatGPTSendMsg 必须接受，且字段齐全。
 *  2. 旧形状（`__deepApiChatGPT: 'send'`，无 kind）必须被拒——防两种形状并存回潮。
 *  3. 流派事件（frame / done / error / stream-start / conversation / ping）不得被当成指令。
 *  4. 端到端：合法 send 包真的驱动 handleSend（composer 被填词 + stream-start 带同一 requestId）；
 *     旧形状包不得驱动任何副作用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBridgeClient, type ChatGPTPortLike } from '../../src/background/providers/chatgpt/bridge-client';
import { isChatGPTSendMsg } from '../../src/shared/chatgpt-protocol';

interface FakePort {
  p: ChatGPTPortLike;
  sent: unknown[];
}

function mkPort(): FakePort {
  const sent: unknown[] = [];
  const p: ChatGPTPortLike = {
    postMessage: (m: unknown) => { sent.push(m); },
    onMessage: () => { /* 本文件不需要入站 */ },
    onDisconnect: () => { /* 本文件不测断线 */ },
  };
  return { p, sent };
}

/**
 * 让**真实的发送端**（bridge-client）产出一条 send 包并返回那条包本身。
 * 不手写、不复制形状——手写正是本 bug 的成因。
 */
function produceRealSend(opts: { requestId: string; text: string; conversationId: string | null }): {
  produced: unknown;
  stop: () => Promise<void>;
} {
  const bc = createBridgeClient({ now: () => 0 });
  const port = mkPort();
  bc.registerPort(port.p);
  const iter = bc.request(opts);
  if (port.sent.length !== 1) throw new Error('bridge-client 未按预期产出恰好一条 send 包');
  return {
    produced: port.sent[0],
    // 迭代器未消费会留下 120s 超时定时器——用 return() 清理，避免测试进程吊着。
    stop: async () => { await iter.return?.(); },
  };
}

describe('发送端真产出的包 → 接收端谓词', () => {
  it('带会话 id 的 send 包：谓词为 true 且字段齐全', async () => {
    const real = produceRealSend({ requestId: 'r-contract', text: '你好', conversationId: 'conv-1' });
    try {
      const produced = real.produced;
      expect(isChatGPTSendMsg(produced)).toBe(true);
      if (!isChatGPTSendMsg(produced)) throw new Error('发送端产出的 send 包被接收端谓词拒绝：契约漂移');
      // 信封：与本协议其余消息（relay 过滤 `=== true`）一致
      expect(produced.__deepApiChatGPT).toBe(true);
      expect(produced.kind).toBe('send');
      // 载荷：三字段一个不少、类型正确
      expect(produced.requestId).toBe('r-contract');
      expect(produced.text).toBe('你好');
      expect(produced.conversationId).toBe('conv-1');
    } finally {
      await real.stop();
    }
  });

  it('新会话（conversationId=null）的 send 包：同样通过，且 conversationId 保持 null', async () => {
    const real = produceRealSend({ requestId: 'r-new', text: 'hi', conversationId: null });
    try {
      const produced = real.produced;
      if (!isChatGPTSendMsg(produced)) throw new Error('新会话 send 包被接收端谓词拒绝：契约漂移');
      expect(produced.requestId).toBe('r-new');
      expect(produced.text).toBe('hi');
      expect(produced.conversationId).toBeNull();
    } finally {
      await real.stop();
    }
  });
});

describe('旧形状与越界形状必须被拒', () => {
  it('**旧形状** `__deepApiChatGPT: "send"`（无 kind）不再被接受（防两种形状并存）', () => {
    expect(isChatGPTSendMsg({ __deepApiChatGPT: 'send', requestId: 'r1', text: 'hi', conversationId: null })).toBe(false);
  });

  it('信封为 false / 缺失 → 拒（只有字面 true 才是本协议消息）', () => {
    expect(isChatGPTSendMsg({ __deepApiChatGPT: false, kind: 'send', requestId: 'r1', text: 'hi', conversationId: null })).toBe(false);
    expect(isChatGPTSendMsg({ kind: 'send', requestId: 'r1', text: 'hi', conversationId: null })).toBe(false);
  });

  it('kind 缺失或不为 "send" → 拒', () => {
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, requestId: 'r1', text: 'hi', conversationId: null })).toBe(false);
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'ping', requestId: 'r1', text: 'hi', conversationId: null })).toBe(false);
  });

  it('载荷缺字段 / 类型不对 → 拒', () => {
    // requestId / text 必须是字符串
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'send', text: 'hi', conversationId: null })).toBe(false);
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'send', requestId: 1, text: 'hi', conversationId: null })).toBe(false);
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'send', requestId: 'r1', text: null, conversationId: null })).toBe(false);
    // conversationId 只接受 string | null（唯一生产者 SW 侧总是显式给值；宽松会让畸形包溜进 handleSend）
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'send', requestId: 'r1', text: 'hi' })).toBe(false);
    expect(isChatGPTSendMsg({ __deepApiChatGPT: true, kind: 'send', requestId: 'r1', text: 'hi', conversationId: 42 })).toBe(false);
  });

  it('非对象输入 → 拒（不抛）', () => {
    expect(isChatGPTSendMsg(null)).toBe(false);
    expect(isChatGPTSendMsg(undefined)).toBe(false);
    expect(isChatGPTSendMsg('send')).toBe(false);
    expect(isChatGPTSendMsg(1)).toBe(false);
  });
});

describe('流派事件不得被判定成指令（否则会把页面回包当成新请求）', () => {
  const streamEvents: unknown[] = [
    { __deepApiChatGPT: true, kind: 'stream-start', requestId: 'r1' },
    { __deepApiChatGPT: true, kind: 'frame', requestId: 'r1', event: 'delta', data: '{"v":"a"}' },
    { __deepApiChatGPT: true, kind: 'conversation', requestId: 'r1', conversationId: 'conv-1' },
    { __deepApiChatGPT: true, kind: 'done', requestId: 'r1' },
    { __deepApiChatGPT: true, kind: 'error', requestId: 'r1', message: 'boom' },
    { __deepApiChatGPT: true, kind: 'ping' },
  ];

  it('全部判 false', () => {
    for (const ev of streamEvents) expect(isChatGPTSendMsg(ev)).toBe(false);
  });
});

describe('端到端：接收端 listener 真的按新契约驱动 handleSend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    sessionStorage.clear();
    delete (window as { __deepApiChatGPTBridgeInstalled?: unknown }).__deepApiChatGPTBridgeInstalled;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('收到发送端真产的 send → composer 被填词 + stream-start 带同一 requestId', async () => {
    const { install } = await import('../../src/content/chatgpt-bridge-main');
    install();
    // composer 与 send 按钮就位，让 handleSend 一次走完（超时路径已由 chatgpt-bridge-send.test.ts 覆盖）
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>'
      + '<button data-testid="send-button">Send</button>';
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);

    const real = produceRealSend({ requestId: 'r-e2e', text: '跨边界你好', conversationId: null });
    window.dispatchEvent(new MessageEvent('message', { data: real.produced, source: window }));
    await vi.advanceTimersByTimeAsync(1000);

    // 载荷真的落到了 composer 上
    expect(document.getElementById('prompt-textarea')?.textContent).toBe('跨边界你好');
    // 同一 requestId 回传给 SW
    const streamStart = postSpy.mock.calls
      .map((c) => c[0] as { __deepApiChatGPT?: unknown; kind?: unknown; requestId?: unknown })
      .find((m) => m.__deepApiChatGPT === true && m.kind === 'stream-start');
    expect(streamStart).toBeDefined();
    expect(streamStart?.requestId).toBe('r-e2e');
    await real.stop();
  });

  it('收到**旧形状**包 → 不驱动任何副作用（composer 不被碰、无 stream-start）', async () => {
    const { install } = await import('../../src/content/chatgpt-bridge-main');
    install();
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>'
      + '<button data-testid="send-button">Send</button>';
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);

    const legacy = { __deepApiChatGPT: 'send', requestId: 'r-legacy', text: '不该被发出去', conversationId: null };
    window.dispatchEvent(new MessageEvent('message', { data: legacy, source: window }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(document.getElementById('prompt-textarea')?.textContent).toBe('');
    const streamStart = postSpy.mock.calls
      .map((c) => c[0] as { __deepApiChatGPT?: unknown; kind?: unknown })
      .find((m) => m.__deepApiChatGPT === true && m.kind === 'stream-start');
    expect(streamStart).toBeUndefined();
  });
});
