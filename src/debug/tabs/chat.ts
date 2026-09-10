// 2026-09-09（feat/debug-chat-redesign）：把控件（model / thinking / search）从顶部 topbar
// 重排到底部 sticky 控件行，学 DeepSeek/ChatGPT 聊天页面风格。同时加 vision 图片上传 UI
// （仅 vision-exp 模型启用上传按钮）；移除 reasoning_effort（DeepSeek 网页无此控件）。
// 保持原 data-* 属性名 + 右键菜单，使现有 chat.test.ts 全 11 个用例过。

type ChatMsg = { role: 'user' | 'assistant'; content: string; reasoning?: string; images?: string[] };

export function mountChat(pane: HTMLElement): () => void {
  const history: ChatMsg[] = [];
  // 缩略图附件：{ id, dataUrl }；用户 addFile 时 push，send / remove 时清理
  const attachments: Array<{ id: string; dataUrl: string }> = [];
  // 在途流的 reader：unmount 时 cancel
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  pane.innerHTML = `
    <div data-chat-stream style="flex:1;overflow:auto;border:1px solid #ddd;padding:8px;margin-bottom:8px;min-height:200px;"></div>
    <div data-chat-thumbs style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;"></div>
    <textarea data-chat-input rows="3" style="width:100%;box-sizing:border-box;"></textarea>
    <div data-chat-controls style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap;">
      <input type="file" data-chat-file-input accept="image/*" multiple style="display:none;">
      <button data-chat-upload title="仅 vision-exp 模型支持图片">📎图片</button>
      <label>model <select data-chat-model></select></label>
      <label>thinking <input type="checkbox" data-chat-thinking checked></label>
      <label><input type="checkbox" data-chat-search>search</label>
      <span style="flex:1"></span>
      <button data-chat-send>发送</button>
    </div>
  `;
  const stream = pane.querySelector('[data-chat-stream]')!;
  const thumbs = pane.querySelector<HTMLElement>('[data-chat-thumbs]')!;
  const input = pane.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
  const sendBtn = pane.querySelector<HTMLButtonElement>('[data-chat-send]')!;
  const modelSel = pane.querySelector<HTMLSelectElement>('[data-chat-model]')!;
  const thinkingCb = pane.querySelector<HTMLInputElement>('[data-chat-thinking]')!;
  const searchCb = pane.querySelector<HTMLInputElement>('[data-chat-search]')!;
  const uploadBtn = pane.querySelector<HTMLButtonElement>('[data-chat-upload]')!;
  const fileInput = pane.querySelector<HTMLInputElement>('[data-chat-file-input]')!;
  // thinkingSel: ts 期望严格，line 13 的 [data-chat-thinking] 没匹配是因为我笔误写 [data-thinking] 吗？
  // 不，模板里写了 data-chat-thinking，重查选择器——

  // 模型联动：vision 模型才能上传；非 vision 禁用上传按钮
  // 2026-09-10（fix/vision-button）：v4.1 Flash 统一后（changelog 9/14 retired 三个 V4 ID），只有
  // `deepseek-flash` 一个模型。V4.1 Flash 原生支持图片（与 vision-exp 走同一服务端路由），
  // 所以现在所有 chat 调的模型都 vision-capable。保留旧 vision-exp 名字做向后兼容（万一某
  // 个本地部署还导出它）。
  const isVisionModel = (id: string): boolean =>
    id === 'deepseek-flash' || id === 'deepseek-v4-flash-vision-exp';
  const refreshUploadState = (): void => {
    const vision = isVisionModel(modelSel.value);
    uploadBtn.disabled = !vision;
    uploadBtn.title = vision ? '点击上传图片' : '当前模型不支持图片';
  };
  modelSel.addEventListener('change', refreshUploadState);
  uploadBtn.addEventListener('click', () => fileInput.click());

  // 加载模型列表（brief 改动说明：原 brief 直接调 window.deepApi.models.list()，
  // 在未注入 deepApi 的上下文（如 tests/demo/debug-panel.test.ts）会抛错；
  // 加可选链守护，缺 API 时静默跳过 — topbar select 为空即回退）
  const api = (window as any).deepApi;
  api?.models?.list?.().then((r: any) => {
    modelSel.innerHTML = (r.data as any[]).map((m: any) => `<option value="${m.id}">${m.description ?? m.id}</option>`).join('');
    refreshUploadState();
  }).catch(() => {});

  // FileReader：读图片为 data URL，加到 attachments + 渲染缩略图
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      const reader = new FileReader();
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        attachments.push({ id, dataUrl });
        renderThumb(id, dataUrl);
      };
      reader.readAsDataURL(f);
    }
    fileInput.value = '';
  });

  const renderThumb = (id: string, dataUrl: string): void => {
    const el = document.createElement('div');
    el.dataset.chatThumb = id;
    el.style.cssText = 'position:relative;display:inline-block;';
    el.innerHTML = `
      <img src="${dataUrl}" style="width:64px;height:64px;object-fit:cover;border:1px solid #ccc;border-radius:4px;">
      <button data-chat-thumb-remove style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;line-height:14px;border-radius:50%;border:1px solid #888;background:#fff;cursor:pointer;padding:0;">×</button>
    `;
    el.querySelector('[data-chat-thumb-remove]')!.addEventListener('click', () => {
      const idx = attachments.findIndex((a) => a.id === id);
      if (idx >= 0) attachments.splice(idx, 1);
      el.remove();
    });
    thumbs.appendChild(el);
  };

  const renderMsg = (m: ChatMsg, isPending = false): HTMLElement => {
    const el = document.createElement('div');
    el.dataset.msg = m.role;
    el.style.cssText = `margin:4px 0;padding:6px;border-radius:4px;text-align:${m.role === 'user' ? 'right' : 'left'};background:${m.role === 'user' ? '#dceaff' : '#f6f6f6'};`;
    // 2026-09-10（fix/image-in-bubble）：图片附件直接渲染到**消息气泡里**（学 ChatGPT/DeepSeek）——
    // 发送后输入区缩略图清空，但图作为消息的一部分保留在这里。
    if (m.images?.length) {
      const strip = document.createElement('div');
      strip.style.cssText = `display:flex;gap:4px;flex-wrap:wrap;justify-content:${m.role === 'user' ? 'flex-end' : 'flex-start'};margin-bottom:4px;`;
      for (const url of m.images) {
        const img = document.createElement('img');
        img.src = url;
        img.style.cssText = 'width:96px;height:96px;object-fit:cover;border:1px solid #ccc;border-radius:4px;';
        strip.appendChild(img);
      }
      el.appendChild(strip);
    }
    const text = document.createElement('div');
    text.textContent = m.content + (isPending ? ' …' : '');
    el.appendChild(text);
    return el;
  };

  // contextmenu 委托在 stream 容器
  stream.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    const msgEl = target?.closest('[data-msg]') as HTMLElement | null;
    if (!msgEl || !stream.contains(msgEl)) return;
    e.preventDefault();
    const idx = Array.prototype.indexOf.call(stream.children, msgEl);
    const m = history[idx] ?? { role: msgEl.dataset.msg as 'user' | 'assistant', content: msgEl.textContent ?? '' };
    showMenu(msgEl, m);
  });

  const showMenu = (anchor: HTMLElement, m: ChatMsg): void => {
    document.querySelector('[data-msg-menu]')?.remove();
    const menu = document.createElement('div');
    menu.dataset.msgMenu = '';
    menu.style.cssText = 'position:fixed;background:#fff;border:1px solid #888;padding:4px;z-index:1000;';
    menu.style.left = (anchor.getBoundingClientRect().left) + 'px';
    menu.style.top  = (anchor.getBoundingClientRect().bottom) + 'px';
    const items = [
      { label: '复制为 messages JSON', act: 'copy-messages' },
      { label: '复制为 curl',         act: 'copy-curl' },
      { label: '从此处重发',           act: 'replay-from-here' },
    ];
    const idx = history.indexOf(m);
    for (const it of items) {
      const btn = document.createElement('button');
      btn.dataset.menuItem = it.act;
      btn.textContent = it.label;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.addEventListener('click', () => {
        if (it.act === 'copy-messages') navigator.clipboard.writeText(JSON.stringify(historyToApiMessages().slice(idx), null, 2));
        if (it.act === 'copy-curl') navigator.clipboard.writeText(toCurl(historyToApiMessages().slice(idx)));
        if (it.act === 'replay-from-here') {
          if (!confirm('从此处重发会删除该消息及之后所有回复，并触发 rebuild（新 web session）。确认？')) return;
          const idx = history.indexOf(m);
          const replayed = history[idx];
          history.length = idx;
          stream.innerHTML = '';
          history.forEach(x => stream.appendChild(renderMsg(x)));
          // 2026-09-10（fix/image-in-bubble）：重发的消息若带图，把 images 放回输入区附件再发
          attachments.length = 0;
          thumbs.innerHTML = '';
          for (const url of (replayed?.images ?? [])) {
            const aid = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            attachments.push({ id: aid, dataUrl: url });
            renderThumb(aid, url);
          }
          doSend(replayed?.content ?? m.content);
        }
        menu.remove();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  };

  const toCurl = (msgs: Array<{ role: string; content: unknown }>): string => {
    const body = JSON.stringify({ model: modelSel.value, messages: msgs, stream: true });
    return `curl -N -X POST https://chat.deepseek.com/api/v0/chat/completion \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  };

  const baseOpts = (): any => {
    const o: any = {};
    if (thinkingCb.checked) o.thinking = true;
    else o.thinking = false;
    if (searchCb.checked) o.search = true;
    return o;
  };

  // 2026-09-10（fix/image-in-bubble）：把 ChatMsg[] 转成 API 消息（带 images → image_url blocks）。
  // 所有对外出口（send / copy-messages / copy-curl）都从这里取，保证一致。
  const historyToApiMessages = (): Array<{ role: string; content: unknown }> =>
    history.map((m) => {
      if (m.role === 'user' && m.images?.length) {
        const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const url of m.images) blocks.push({ type: 'image_url', image_url: { url } });
        return { role: m.role, content: blocks };
      }
      return { role: m.role, content: m.content };
    });

  const doSend = async (text: string): Promise<void> => {
    const imageUrls = attachments.map((a) => a.dataUrl);
    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      ...(imageUrls.length ? { images: imageUrls } : {}),
    };
    history.push(userMsg);
    const userEl = renderMsg(userMsg);
    stream.appendChild(userEl);

    const asstEl = renderMsg({ role: 'assistant', content: '' }, true);
    stream.appendChild(asstEl);
    asstEl.textContent = ' …';

    // 发给 deepApi 的 messages 统一从 history 转换（含所有历史图片 → image_url blocks）
    const sentMessages = historyToApiMessages();

    try {
      const res = await (window as any).deepApi.chat.completions.create({
        model: modelSel.value, messages: sentMessages, ...baseOpts(), stream: true,
      });
      const reader = res.body.getReader();
      currentReader = reader;
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let content = '';
      let streamErr: string | null = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            // 2026-09-10（fix/vision-errors）：SSE error 帧（SW 把 BridgeError 转成 error 帧推回）
            // 必须显示——否则带图失败时用户只看到空回复（现场：带图发送无任何响应）。
            if (j.error) { streamErr = j.error.message ?? JSON.stringify(j.error); continue; }
            const d = j.choices?.[0]?.delta;
            if (d?.content) { content += d.content; asstEl.textContent = content; }
          } catch {}
        }
      }
      if (streamErr) {
        // 失败：显示错误，**不清附件**（用户可修好后重发同一张图），不污染历史
        asstEl.textContent = '[错误] ' + streamErr;
        stream.scrollTop = stream.scrollHeight;
        return;
      }
      history.push({ role: 'assistant', content });
      asstEl.textContent = content;
      // 发送完清理附件（一次性 image_url）
      attachments.length = 0;
      thumbs.innerHTML = '';
    } catch (e: any) {
      asstEl.textContent = '[错误] ' + (e?.message ?? String(e));
    }
    stream.scrollTop = stream.scrollHeight;
  };

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text && attachments.length === 0) return;
    input.value = '';
    void doSend(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  return () => { pane.innerHTML = ''; void currentReader?.cancel().catch(() => undefined); };
}