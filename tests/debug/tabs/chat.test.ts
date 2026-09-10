import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountChat } from '../../../src/debug/tabs/chat';

beforeEach(() => {
  // mock window.deepApi
  (globalThis as any).window = globalThis;
  (globalThis as any).deepApi = {
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }) } },
    models: { list: vi.fn().mockResolvedValue({ data: [{ id: 'm1', description: 'Mock Model 1' }] }) },
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

// 2026-09-09（feat/debug-chat-redesign）：把控件从顶部 topbar 重排为底部控件行
// （学 DeepSeek/ChatGPT 聊天页面风格）。保持原有 data-* 属性名使旧测试过过。
describe('mountChat: 控件重排 + 移除 reasoning_effort', () => {
  it('控件行在 textarea 与 send 按钮之后（顺序: stream > textarea > 控件行 > send）', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    const stream = pane.querySelector('[data-chat-stream]')!;
    const input = pane.querySelector('[data-chat-input]')!;
    const sendBtn = pane.querySelector('[data-chat-send]')!;
    const modelSel = pane.querySelector('[data-chat-model]')!;
    const thinkingSel = pane.querySelector('[data-chat-thinking]')!;
    const searchCb = pane.querySelector('[data-chat-search]')!;
    // stream 第一个；input 接下来；model/thinking/search 在 input 之后；send 最后
    expect(stream.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.compareDocumentPosition(modelSel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modelSel.compareDocumentPosition(thinkingSel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thinkingSel.compareDocumentPosition(searchCb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(searchCb.compareDocumentPosition(sendBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reasoning_effort 已移除（DeepSeek 网页不设这个控件，对齐）', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    expect(pane.querySelector('[data-chat-effort]')).toBeNull();
  });

  it('流区域不写死 max-height：60vh——改用 flex 布局贴高', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    const stream = pane.querySelector('[data-chat-stream]') as HTMLElement;
    // 移除 60vh 限制，不应再有 max-height:60vh
    const style = stream.getAttribute('style') || '';
    expect(style).not.toMatch(/max-height:\s*60vh/);
  });
});

// 2026-09-09（feat/debug-chat-redesign）：图片上传 UI（Vision multimodal 调试用）。
// FileReader readAsDataURL mock + 缩略图预览 + 发送转 content array。
describe('mountChat: vision 图片上传', () => {
  it('渲染上传按钮（默认 model = deepseek-flash 时启用 + tooltip）', async () => {
    // 2026-09-09（fix/vision-button）：v4.1 Flash 统一后只有 deepseek-flash 一个模型。
    // 它支持图片（changelog 实测）——按钮应该默认 enabled，不再是灰的。
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [
        { id: 'deepseek-flash', description: 'DeepSeek V4.1 Flash' },
      ],
    });
    const pane = document.createElement('div');
    mountChat(pane);
    // 等模型列表加载
    await new Promise(r => setTimeout(r, 10));
    const uploadBtn = pane.querySelector<HTMLButtonElement>('[data-chat-upload]');
    expect(uploadBtn).toBeTruthy();
    // 默认选第一个 model（deepseek-flash）—— 上传按钮应启用
    expect(uploadBtn!.disabled).toBe(false);
    expect(uploadBtn!.title).toMatch(/上传图片|点击/);
  });

  it('thinking 控件是 checkbox（与 search 保持一致）', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [{ id: 'deepseek-flash', description: 'DeepSeek V4.1 Flash' }],
    });
    const pane = document.createElement('div');
    mountChat(pane);
    await new Promise(r => setTimeout(r, 10));
    const thinkingCb = pane.querySelector<HTMLInputElement>('[data-chat-thinking]');
    expect(thinkingCb).toBeTruthy();
    expect(thinkingCb!.type).toBe('checkbox');
  });

  it('search 控件是 checkbox（回归——确认与 thinking 一致）', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [{ id: 'deepseek-flash', description: 'DeepSeek V4.1 Flash' }],
    });
    const pane = document.createElement('div');
    mountChat(pane);
    await new Promise(r => setTimeout(r, 10));
    const searchCb = pane.querySelector<HTMLInputElement>('[data-chat-search]');
    expect(searchCb).toBeTruthy();
    expect(searchCb!.type).toBe('checkbox');
  });

  it('选 deepseek-flash 模型后，上传按钮启用（回归——旧 vision-exp 名字不出现）', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [
        { id: 'deepseek-flash', description: 'DeepSeek V4.1 Flash' },
      ],
    });
    const pane = document.createElement('div');
    mountChat(pane);
    await new Promise(r => setTimeout(r, 10));
    const modelSel = pane.querySelector<HTMLSelectElement>('[data-chat-model]')!;
    modelSel.value = 'deepseek-flash';
    modelSel.dispatchEvent(new Event('change'));
    const uploadBtn = pane.querySelector<HTMLButtonElement>('[data-chat-upload]')!;
    expect(uploadBtn.disabled).toBe(false);
  });

  it('选文件后：FileReader readAsDataURL → 缩略图预览 + 缩略图 × 按钮', async () => {
    // mock FileReader
    const origFileReader = (globalThis as any).FileReader;
    let lastReader: any = null;
    (globalThis as any).FileReader = class {
      onload: ((e: any) => void) | null = null;
      result: string | null = null;
      readAsDataURL(_blob: Blob) {
        lastReader = this;
        this.result = 'data:image/png;base64,FAKE';
        queueMicrotask(() => this.onload?.({ target: this } as never));
      }
    };
    try {
      const pane = document.createElement('div');
      mountChat(pane);
      // 启用上传
      const modelSel = pane.querySelector<HTMLSelectElement>('[data-chat-model]')!;
      const uploadBtn = pane.querySelector<HTMLButtonElement>('[data-chat-upload]')!;
      // mock file input click + change
      const fileInput = pane.querySelector<HTMLInputElement>('[data-chat-file-input]')!;
      const file = new Blob([ new Uint8Array([1, 2, 3]) ], { type: 'image/png' });
      // 设置 file（jsdom 用 defineProperty 覆盖原型 getter）
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 10));
      // 缩略图出现
      const thumbs = pane.querySelectorAll('[data-chat-thumb]');
      expect(thumbs.length).toBe(1);
      // × 按钮可点
      const removeBtn = thumbs[0]!.querySelector('[data-chat-thumb-remove]');
      expect(removeBtn).toBeTruthy();
      removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5));
      expect(pane.querySelectorAll('[data-chat-thumb]').length).toBe(0);
    } finally {
      (globalThis as any).FileReader = origFileReader;
    }
  });

  it('发送时：图片 + 文本 → content array 含 image_url + text 块', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [{ id: 'deepseek-v4-flash-vision-exp', description: 'DeepSeek V4 Flash Vision Exp' }],
    });
    // mock FileReader（同步触发 onload）
    const origFileReader = (globalThis as any).FileReader;
    class MockFR {
      result: string | null = null;
      onload: ((e: any) => void) | null = null;
      readAsDataURL(_b: Blob) {
        this.result = 'data:image/png;base64,FAKE_BYTES';
        queueMicrotask(() => this.onload?.({ target: this } as never));
      }
    }
    (globalThis as any).FileReader = MockFR;
    // mock SSE 流响应
    const sseBody = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')); c.close(); },
    });
    const createMock = vi.fn().mockResolvedValue({ body: sseBody });
    (globalThis as any).deepApi.chat.completions.create = createMock;

    try {
      const pane = document.createElement('div');
      mountChat(pane);
      await new Promise(r => setTimeout(r, 10));  // 等模型列表
      // 加图片
      const fileInput = pane.querySelector<HTMLInputElement>('[data-chat-file-input]')!;
      Object.defineProperty(fileInput, 'files', { value: [new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })], configurable: true });
      fileInput.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 20));  // 等 FileReader setTimeout(0) + 渲染缩略图
      // 确认缩略图已渲染
      expect(pane.querySelectorAll('[data-chat-thumb]').length).toBe(1);
      // 输入文本 + 发送
      const input = pane.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
      input.value = '看这图';
      pane.querySelector<HTMLButtonElement>('[data-chat-send]')!.click();
      await new Promise(r => setTimeout(r, 30));

      expect(createMock).toHaveBeenCalledTimes(1);
      const args = createMock.mock.calls[0]![0];
      const userMsg = args.messages[args.messages.length - 1];
      expect(Array.isArray(userMsg.content)).toBe(true);
      const types = userMsg.content.map((b: any) => b.type);
      expect(types).toContain('text');
      expect(types).toContain('image_url');
      const imgBlock = userMsg.content.find((b: any) => b.type === 'image_url');
      expect(imgBlock.image_url.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      (globalThis as any).FileReader = origFileReader;
    }
  });
});

// 2026-09-10（feat/models-sync）：model <option> 文本使用 m.description（catalog
// 抓取的 label），无 description 时回退到 m.id。
describe('mountChat: model option 文本 = m.description (catalog label)', () => {
  it('渲染时用 description 作为 option 文本（value 仍用 id）', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [
        { id: 'deepseek-v4-flash', description: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', description: 'DeepSeek V4 Pro' },
      ],
    });
    const pane = document.createElement('div');
    mountChat(pane);
    await new Promise(r => setTimeout(r, 10));
    const opts = Array.from(pane.querySelectorAll('[data-chat-model] option'));
    expect(opts).toHaveLength(2);
    expect((opts[0] as HTMLOptionElement).textContent).toBe('DeepSeek V4 Flash');
    expect((opts[0] as HTMLOptionElement).value).toBe('deepseek-v4-flash');
    expect((opts[1] as HTMLOptionElement).textContent).toBe('DeepSeek V4 Pro');
    expect((opts[1] as HTMLOptionElement).value).toBe('deepseek-v4-pro');
  });

  it('description 缺失时回退到 id（catalog 过期 / null 场景）', async () => {
    (globalThis as any).deepApi.models.list = vi.fn().mockResolvedValue({
      data: [{ id: 'deepseek-v4-flash' }],  // 无 description
    });
    const pane = document.createElement('div');
    mountChat(pane);
    await new Promise(r => setTimeout(r, 10));
    const opt = pane.querySelector('[data-chat-model] option') as HTMLOptionElement;
    expect(opt.textContent).toBe('deepseek-v4-flash');
    expect(opt.value).toBe('deepseek-v4-flash');
  });
});