import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountChat } from '../../../src/debug/tabs/chat';

beforeEach(() => {
  // mock window.deepApi
  (globalThis as any).window = globalThis;
  (globalThis as any).deepApi = {
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }) } },
    models: { list: vi.fn().mockResolvedValue({ data: [{ id: 'm1' }] }) },
  };
  // 屏蔽 topbar 渲染失败（模型列表的 select 控件）
});

describe('mountChat', () => {
  it('渲染消息流容器 + 输入框 + 顶部模型参数栏', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    expect(pane.querySelector('[data-chat-stream]')).toBeTruthy();
    expect(pane.querySelector('[data-chat-input]')).toBeTruthy();
    expect(pane.querySelector('[data-chat-send]')).toBeTruthy();
  });

  it('点击 send 调 deepApi.chat.completions.create 并追加消息', async () => {
    const pane = document.createElement('div');
    mountChat(pane);
    const input = pane.querySelector('[data-chat-input]') as HTMLTextAreaElement;
    input.value = 'hi';
    pane.querySelector<HTMLButtonElement>('[data-chat-send]')!.click();
    // 等异步链
    await new Promise(r => setTimeout(r, 10));
    expect((globalThis as any).deepApi.chat.completions.create).toHaveBeenCalled();
    expect(pane.querySelectorAll('[data-msg]').length).toBeGreaterThan(0);
  });

  it('右键消息弹出菜单有 3 个 item', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    // 先追加一条消息（直接操作 history）
    const stream = pane.querySelector('[data-chat-stream]')!;
    stream.innerHTML = '<div data-msg="user">hi</div>';
    const msgEl = stream.querySelector('[data-msg]')!;
    msgEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menu = document.querySelector('[data-msg-menu]');
    expect(menu?.querySelectorAll('[data-menu-item]')).toHaveLength(3);
  });

  // 回归：spec「把当前消息及之后的所有消息作为 messages 数组复制到剪贴板」
  // 未修复时 history.indexOf 已在 showMenu 内 hoisted，copy-messages / copy-curl 须以 slice(idx) 输出
  it('复制为 messages JSON 按右键消息起 slice（spec 合规）', async () => {
    // 构造 SSE 流响应，使 history 中确实存在 assistant 条目
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n',
        ));
        controller.close();
      },
    });
    (globalThis as any).deepApi.chat.completions.create = vi.fn().mockResolvedValue({ body: sseBody });

    const pane = document.createElement('div');
    mountChat(pane);
    const stream = pane.querySelector('[data-chat-stream]')!;
    const input = pane.querySelector('[data-chat-input]') as HTMLTextAreaElement;
    const sendBtn = pane.querySelector<HTMLButtonElement>('[data-chat-send]')!;

    input.value = 'hi';
    sendBtn.click();
    // 等 SSE 消费 + history.push(assistant) 完成
    await new Promise(r => setTimeout(r, 30));

    // 捕获剪贴板
    let captured = '';
    const origClipboard = (navigator as any).clipboard;
    (navigator as any).clipboard = { writeText: (s: string) => { captured = s; } };

    try {
      // 右键 assistant 消息（stream.children[1]）
      const asstEl = stream.children[1] as HTMLElement;
      asstEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

      const menu = document.querySelector('[data-msg-menu]');
      const copyBtn = menu?.querySelector<HTMLButtonElement>('[data-menu-item="copy-messages"]');
      expect(copyBtn).toBeTruthy();
      copyBtn!.click();

      const parsed = JSON.parse(captured);
      expect(Array.isArray(parsed)).toBe(true);
      // spec: 从右键消息起（含）的所有消息；右键在 assistant 上 → 只包含 assistant
      expect(parsed).toHaveLength(1);
      expect(parsed[0].role).toBe('assistant');
      expect(parsed[0].content).toBe('reply');
    } finally {
      (navigator as any).clipboard = origClipboard;
    }
  });
});