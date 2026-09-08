/**
 * 共享 demo runner — 供 demo-page (examples/demo-page/index.html) 和 popup "Open Demo" 折叠面板使用。
 * 接收 mountPoint: HTMLElement（容器），渲染 demo 控件进去；
 * 内部所有 querySelector 都用 root 限定（不污染 document 全局），多次 mount 互不冲突。
 */
export interface MountOptions { showLimitationBanner?: boolean }

const DEMO_HTML = `
<div class="demo-panel">
  <details class="demo-warn-block" open>
    <summary>⚠️ 已知 limitation（点击展开）</summary>
    <div class="demo-warn-body">
      deep.api 走网页 web API（chat.deepseek.com/api/v0），与官方 API（api.deepseek.com）字段有差异。<code>thinking_enabled</code> / <code>reasoning_effort</code> 字段是 no-op：<code>message.reasoning_content</code> 始终为空，SSE 流里没有思考增量。<code>search_enabled: true</code> 真实有效（v0.1.35 实测确认）。
    </div>
  </details>

  <div class="demo-section">
    <div class="demo-section-title">① 通用参数</div>
    <div class="demo-row">
      <label>模型 <select class="demo-model"></select></label>
      <label>thinking
        <select class="demo-thinking">
          <option value="">（默认 true）</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
      <label><input type="checkbox" class="demo-search">search（联网）</label>
      <label>reasoning_effort
        <select class="demo-effort">
          <option value="">（默认 high）</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </label>
    </div>
  </div>

  <div class="demo-section">
    <div class="demo-section-title">② 快速场景</div>
    <div class="demo-row">
      <button data-act="one">非流式问答</button>
      <button data-act="stream">流式问答</button>
      <button data-act="tool-auto">工具调用 (auto)</button>
      <button data-act="tool-required">工具调用 (required)</button>
      <button data-act="rebuild">修改历史重发（rebuild）</button>
      <button data-act="conv">conversation_id 续聊</button>
    </div>
  </div>

  <pre class="demo-out"></pre>
</div>
`;

/** 挂载 demo 控件到 mountPoint。返回清理函数（unmount）。 */
export function mountDemo(mountPoint: HTMLElement, _opts: MountOptions = {}): () => void {
  mountPoint.innerHTML = DEMO_HTML;
  const root = mountPoint;  // 所有 querySelector 在 root 范围内（多次 mount 隔离）
  const $ = <T extends Element = HTMLElement>(sel: string): T | null => root.querySelector(sel);
  const $$ = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(root.querySelectorAll(sel));

  const outEl = $('.demo-out') as HTMLPreElement;
  const log = (s: string): void => { outEl.textContent += s + '\n'; };
  const reset = (): void => { outEl.textContent = ''; };
  const dump = (label: string, messages: any[]): void => {
    log('─── ' + label + ' ───');
    messages.forEach((m, i) => {
      const role = m?.role || '?';
      const body = JSON.stringify(m);
      log('[' + (i + 1) + ' ' + role + '] ' + body);
    });
  };
  const dumpChoice = (tag: string, choice: any): void => {
    log(tag + ' finish_reason=' + (choice?.finish_reason ?? '?') +
        ' | reasoning=' + (choice?.message?.reasoning_content ? JSON.stringify(String(choice.message.reasoning_content).slice(0, 60)) : '空') +
        ' | content=' + (choice?.message?.content ? JSON.stringify(String(choice.message.content).slice(0, 120)) : '空') +
        (choice?.message?.tool_calls ? ' | tool_calls=' + JSON.stringify(choice.message.tool_calls) : ''));
  };
  const baseOpts = (): any => {
    const o: any = {};
    const tEl = $('.demo-thinking') as HTMLSelectElement | null;
    const t = tEl?.value;
    if (t === 'true') o.thinking = true;
    else if (t === 'false') o.thinking = false;
    const sEl = $('.demo-search') as HTMLInputElement | null;
    if (sEl?.checked) o.search = true;
    const eEl = $('.demo-effort') as HTMLSelectElement | null;
    const e = eEl?.value;
    if (e) o.reasoning_effort = e;
    return o;
  };
  const model = (): string => ($('.demo-model') as HTMLSelectElement | null)?.value ?? '';
  const logError = (e: unknown): void => log('[错误] ' + ((e as any)?.message ?? JSON.stringify(e)));

  // 加载模型列表
  (async () => {
    try {
      const list = await (window as any).deepApi.models.list();
      const mEl = $('.demo-model') as HTMLSelectElement | null;
      if (mEl) mEl.innerHTML = (list.data as Array<{ id: string }>).map(m => `<option value="${m.id}">${m.id}</option>`).join('');
    } catch (e) { log('[初始化失败] ' + ((e as any)?.message ?? JSON.stringify(e))); }
  })();

  async function runToolScenario(modelId: string, choice: string): Promise<void> {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: '取某地天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    let msgs: any[] = [{ role: 'user', content: '北京天气如何？' }];
    const opts = baseOpts();
    const r1 = await (window as any).deepApi.chat.completions.create({ model: modelId, messages: msgs, tools, tool_choice: choice, ...opts });
    const tc = r1.choices[0].message.tool_calls?.[0];
    msgs.push({ role: 'assistant', content: r1.choices[0].message.content || null, ...(tc ? { tool_calls: [tc] } : {}) });
    dump('[tool_choice=' + choice + '] 第一轮后历史', msgs);
    dumpChoice('  [第一轮]', r1.choices[0]);
    if (tc) {
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: '晴 26°C 微风' });
      msgs.push({ role: 'user', content: '那明天呢？' });
      // 第二轮用 'auto'：required 强指令会让模型每轮都调工具，无法自然回答
      const r2 = await (window as any).deepApi.chat.completions.create({ model: modelId, messages: msgs, tools, tool_choice: 'auto', ...opts });
      msgs.push({ role: 'assistant', content: r2.choices[0].message.content || null, ...(r2.choices[0].message.tool_calls ? { tool_calls: r2.choices[0].message.tool_calls } : {}) });
      dump('[tool_choice=' + choice + '] 第二轮后完整历史', msgs);
      dumpChoice('  [第二轮]', r2.choices[0]);
    } else {
      log('[第二轮] （跳过——第一轮未调用工具）');
    }
  }

  const buttons = $$('button[data-act]');
  const handlers: Array<{ btn: HTMLButtonElement; handler: (e: Event) => Promise<void> }> = [];
  for (const btn of buttons) {
    const handler = async (): Promise<void> => {
      reset();
      const act = (btn as any).dataset.act;
      const m = model();
      const opts = baseOpts();
      (btn as HTMLButtonElement).classList.add('busy'); (btn as HTMLButtonElement).disabled = true;
      try {
        if (act === 'one') {
          const msgs = [{ role: 'user', content: '用一句话介绍 DeepSeek。' }];
          const r = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts });
          msgs.push({ role: 'assistant', content: r.choices[0].message.content });
          dump('非流式问答', msgs);
          dumpChoice('[非流式]', r.choices[0]);
        } else if (act === 'stream') {
          const msgs = [{ role: 'user', content: '用三句话讲讲 R1 推理模型。' }];
          const res = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts, stream: true });
          log('[流式开始；收到 SSE 帧：');
          let content = '', reasoning = '';
          let buf = '';
          for await (const frame of res as AsyncIterable<string>) {
            buf += frame;
            let nl: number;
            while ((nl = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
              const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const payload = dataLine.slice(6);
              if (payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const d = j.choices?.[0]?.delta;
                if (!d) continue;
                if (d.reasoning_content) reasoning += d.reasoning_content;
                if (d.content) content += d.content;
              } catch { /* ignore malformed frame */ }
            }
          }
          log(']');
          msgs.push({ role: 'assistant', content });
          dump('流式问答', msgs);
          dumpChoice('[流式]', { message: { content, reasoning_content: reasoning || null, tool_calls: null }, finish_reason: 'stop' });
        } else if (act === 'tool-auto') {
          await runToolScenario(m, 'auto');
        } else if (act === 'tool-required') {
          await runToolScenario(m, 'required');
        } else if (act === 'rebuild') {
          // 演示 deep.api mapper 的 rebuild 分支：修改历史 assistant 回复（'4' → '五'）重发。
          // deep.api 不支持运行时编辑已发送的消息（edit_message 端点 v1 未实现），因此 mirror 不匹配 → rebuild → 开新 session。
          // 网页端会看到两个 chat thread（这是设计行为，不是 bug）。需要"真正在同一 session 上修改历史"需走 DeepSeek 网页 UI 的"编辑"按钮或 v2 spike edit_message 端点。
          const m1 = [{ role: 'user', content: '2+2 等于几？' }];
          const a1 = [{ role: 'assistant', content: '4' }];
          const m2 = [{ role: 'user', content: '2+2 等于几？' }, { role: 'assistant', content: '五' }, { role: 'user', content: '再说一遍？' }];
          const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: m1.concat(a1), ...opts });
          log('[第一次调用]');
          dumpChoice('  [第一次]', r1.choices[0]);
          const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: m2, ...opts });
          log('[第二次调用（修改历史 rebuild，新 session）]');
          dump('  rebuild 后传入的 messages', m2);
          dumpChoice('  [第二次]', r2.choices[0]);
        } else if (act === 'conv') {
          const cid = 'demo-' + Date.now();
          // 多轮调用契约：messages 必须包含完整历史（仿 OpenAI SDK），不能只传新一条
          const history: any[] = [{ role: 'user', content: '记住数字 42。' }];
          const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
          history.push({ role: 'assistant', content: r1.choices[0].message.content });
          history.push({ role: 'user', content: '刚才那个数字是什么？' });
          const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
          history.push({ role: 'assistant', content: r2.choices[0].message.content });
          log('[conversation_id=' + cid + ']');
          dump('续聊完整历史', history);
          dumpChoice('  [第一轮]', r1.choices[0]);
          dumpChoice('  [第二轮]', r2.choices[0]);
        }
      } catch (e) {
        logError(e);
      } finally {
        (btn as HTMLButtonElement).classList.remove('busy');
        (btn as HTMLButtonElement).disabled = false;
      }
    };
    btn.addEventListener('click', handler);
    handlers.push({ btn: btn as HTMLButtonElement, handler });
  }

  return () => {
    for (const { btn, handler } of handlers) btn.removeEventListener('click', handler);
    mountPoint.innerHTML = '';
  };
}
