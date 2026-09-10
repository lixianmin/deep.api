type ChatMsg = { role: 'user' | 'assistant'; content: string; reasoning?: string };

export function mountChat(pane: HTMLElement): () => void {
  const history: ChatMsg[] = [];
  // 在途流的 reader：unmount 时 cancel，避免面板销毁后流继续跑（原 `abort` 变量从未赋值，
  // 是个永远 no-op 的死代码；改用真实 reader 让取消意图生效）。
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  pane.innerHTML = `
    <div data-topbar>
      <label>model <select data-chat-model></select></label>
      <label>thinking <select data-chat-thinking><option value="">(default true)</option><option value="true">true</option><option value="false">false</option></select></label>
      <label><input type="checkbox" data-chat-search>search</label>
      <label>reasoning_effort <select data-chat-effort><option value="">(default high)</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select></label>
    </div>
    <div data-chat-stream style="max-height:60vh;overflow:auto;border:1px solid #ddd;padding:8px;margin:8px 0;"></div>
    <textarea data-chat-input rows="3" style="width:100%;"></textarea>
    <button data-chat-send>发送</button>
  `;
  const stream = pane.querySelector('[data-chat-stream]')!;
  const input = pane.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
  const sendBtn = pane.querySelector<HTMLButtonElement>('[data-chat-send]')!;
  const modelSel = pane.querySelector<HTMLSelectElement>('[data-chat-model]')!;
  const thinkingSel = pane.querySelector<HTMLSelectElement>('[data-chat-thinking]')!;
  const searchCb = pane.querySelector<HTMLInputElement>('[data-chat-search]')!;
  const effortSel = pane.querySelector<HTMLSelectElement>('[data-chat-effort]')!;

  // 加载模型列表（brief 改动说明：原 brief 直接调 window.deepApi.models.list()，
  // 在未注入 deepApi 的上下文（如 tests/demo/debug-panel.test.ts）会抛错；
  // 加可选链守护，缺 API 时静默跳过 — topbar select 为空即回退）
  const api = (window as any).deepApi;
  api?.models?.list?.().then((r: any) => {
    modelSel.innerHTML = (r.data as any[]).map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  }).catch(() => {});

  const renderMsg = (m: ChatMsg, isPending = false): HTMLElement => {
    const el = document.createElement('div');
    el.dataset.msg = m.role;
    el.style.cssText = `margin:4px 0;padding:6px;border-radius:4px;text-align:${m.role === 'user' ? 'right' : 'left'};background:${m.role === 'user' ? '#dceaff' : '#f6f6f6'};`;
    el.textContent = m.content + (isPending ? ' …' : '');
    return el;
  };

  // contextmenu 委托在 stream 容器（brief 改动说明：原 brief 在 renderMsg 内逐元素绑定，
  // 与 brief Step 1 测试用 innerHTML 直接注入的 [data-msg] 元素不兼容；
  // 委托模式同时是更通用的生产实现）
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
    // 右键消息在 history 中的下标：复制类操作按 spec「把当前消息及之后的所有消息」取 slice
    const idx = history.indexOf(m);
    for (const it of items) {
      const btn = document.createElement('button');
      btn.dataset.menuItem = it.act;
      btn.textContent = it.label;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.addEventListener('click', () => {
        if (it.act === 'copy-messages') navigator.clipboard.writeText(JSON.stringify(history.slice(idx), null, 2));
        if (it.act === 'copy-curl') navigator.clipboard.writeText(toCurl(history.slice(idx)));
        if (it.act === 'replay-from-here') {
          if (!confirm('从此处重发会删除该消息及之后所有回复，并触发 rebuild（新 web session）。确认？')) return;
          const idx = history.indexOf(m);
          history.length = idx;   // 截断
          stream.innerHTML = '';
          history.forEach(x => stream.appendChild(renderMsg(x)));
          // 重发被删的 user 内容（简化：取 m.content）
          doSend(m.content);
        }
        menu.remove();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  };

  const toCurl = (msgs: ChatMsg[]): string => {
    const body = JSON.stringify({ model: modelSel.value, messages: msgs, stream: true });
    return `curl -N -X POST https://chat.deepseek.com/api/v0/chat/completion \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  };

  const baseOpts = (): any => {
    const o: any = {};
    const t = thinkingSel.value;
    if (t === 'true') o.thinking = true;
    else if (t === 'false') o.thinking = false;
    if (searchCb.checked) o.search = true;
    const e = effortSel.value;
    if (e) o.reasoning_effort = e;
    return o;
  };

  const doSend = async (text: string): Promise<void> => {
    const userMsg: ChatMsg = { role: 'user', content: text };
    history.push(userMsg);
    const userEl = renderMsg(userMsg);
    stream.appendChild(userEl);

    const asstEl = renderMsg({ role: 'assistant', content: '' }, true);
    stream.appendChild(asstEl);
    asstEl.textContent = ' …';

    try {
      const res = await (window as any).deepApi.chat.completions.create({
        model: modelSel.value, messages: history, ...baseOpts(), stream: true,
      });
      // SSE 流式消费（与 demo.js:156 相同的 reader + TextDecoder 逻辑）
      const reader = res.body.getReader();
      currentReader = reader;
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let content = '';
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
            const d = j.choices?.[0]?.delta;
            if (d?.content) { content += d.content; asstEl.textContent = content; }
          } catch {}
        }
      }
      history.push({ role: 'assistant', content });
      asstEl.textContent = content;
    } catch (e: any) {
      asstEl.textContent = '[错误] ' + (e?.message ?? String(e));
    }
    stream.scrollTop = stream.scrollHeight;
  };

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void doSend(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  return () => { pane.innerHTML = ''; void currentReader?.cancel().catch(() => undefined); };
}