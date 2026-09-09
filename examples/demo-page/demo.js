// Shim: 如果 page 是 chrome-extension://.../demo/ 加载的，content script 不会注入 window.deepApi。
// 这种场景下我们自己用 chrome.runtime.connect('deepapi') 直连 SW，模拟 window.deepApi。
// 外部网页场景（chat.deepseek.com / example.com 等）由 bridge-main 注入 window.deepApi，走原来的桥。
if (!window.deepApi && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
  const pending = new Map();
  const port = chrome.runtime.connect({ name: 'deepapi' });
  let seq = 0;
  const sseChunkFrame = (c) => 'data: ' + JSON.stringify(c) + '\n\n';
  const sseErrorFrame = (err) => 'data: ' + JSON.stringify({ error: err.error || { message: 'unknown', code: 'internal_error' } }) + '\n\n';

  port.onMessage.addListener((env) => {
    if (!env || !env.__deepApi) return;
    const e = env.__deepApi;
    const p = pending.get(e.id);
    if (!p) return;
    if (e.kind === 'chunk') {
      // 流式：推 SSE 帧到队列
      if (p.isStream) {
        p.queue.push(sseChunkFrame(e.chunk));
        const w = p._wake; if (w) { p._wake = null; w(); }
      } else {
        // 非流式：SW 不应发 chunk（v0.1.45 修复后非流式只发 result）。忽略。
      }
    } else if (e.kind === 'result') {
      pending.delete(e.id);
      if (p.isStream) {
        // 流式不会发 result；忽略。
      } else {
        p.settled = true;
        const w = p._wake; if (w) { p._wake = null; w(); }
        p._resolve && p._resolve(e.value);
      }
    } else if (e.kind === 'done') {
      pending.delete(e.id);
      p.settled = true;
      const w = p._wake; if (w) { p._wake = null; w(); }
      if (p.isStream) {
        // 流式收尾：推 [DONE] SSE 帧
        p.queue.push('data: [DONE]\n\n');
        if (p._wake) { p._wake = null; p._wake(); }
      }
      // 非流式不发 done（已收 result）
    } else if (e.kind === 'error') {
      pending.delete(e.id);
      p.settled = true;
      const w = p._wake; if (w) { p._wake = null; w(); }
      if (p.isStream) {
        p.queue.push(sseErrorFrame(e.error));
        p.queue.push('data: [DONE]\n\n');
        if (p._wake) { p._wake = null; p._wake(); }
      } else {
        p._reject && p._reject(new Error((e.error && e.error.error && e.error.error.message) || 'bridge error'));
      }
    }
  });

  const send = (params) => {
    const id = ++seq;
    const isStream = !!params.stream;
    const p = { isStream, queue: [], settled: false };
    pending.set(id, p);
    port.postMessage({ __deepApi: { id, method: 'chat.completions.create', params } });
    if (isStream) {
      // 流式：返回 AsyncIterable<string>，消费 SSE 帧
      return (async function* () {
        while (true) {
          if (p.queue.length) { yield p.queue.shift(); continue; }
          if (p.settled) return;
          await new Promise((r) => { p._wake = r; });
        }
      })();
    }
    // 非流式：返回 Promise<ChatCompletion>
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  const sendSimple = (method, params) => {
    const id = ++seq;
    const p = { isStream: false, queue: [], settled: false };
    pending.set(id, p);
    port.postMessage({ __deepApi: { id, method, params } });
    return new Promise((res, rej) => { p._resolve = res; p._reject = rej; });
  };

  window.deepApi = {
    models: { list: () => sendSimple('models.list', {}) },
    chat: { completions: { create: send } },
  };
}

const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };
const reset = () => { out.textContent = ''; };

/** 格式化完整 messages 历史：每条一行 JSON，方便复制贴贴排错。 */
const dump = (label, messages) => {
  log('─── ' + label + ' ───');
  messages.forEach((m, i) => {
    const role = m.role || '?';
    const body = JSON.stringify(m);
    log('[' + (i + 1) + ' ' + role + '] ' + body);
  });
};
/** 格式化一轮调用的关键元信息（可选：传 r.choices[0]）。 */
const dumpChoice = (tag, choice) => {
  log(tag + ' finish_reason=' + (choice.finish_reason ?? '?') +
      ' | reasoning=' + (choice.message?.reasoning_content ? JSON.stringify(choice.message.reasoning_content.slice(0, 60)) : '空') +
      ' | content=' + (choice.message?.content ? JSON.stringify(choice.message.content.slice(0, 120)) : '空') +
      (choice.message?.tool_calls ? ' | tool_calls=' + JSON.stringify(choice.message.tool_calls) : ''));
};

const $ = (id) => document.getElementById(id);
const model = () => $('model').value;
const baseOpts = () => {
  const o = {};
  const t = $('thinking').value;
  if (t === 'true') o.thinking = true;
  else if (t === 'false') o.thinking = false;
  if ($('search').checked) o.search = true;
  const e = $('effort').value;
  if (e) o.reasoning_effort = e;
  return o;
};

(async () => {
  try {
    const list = await window.deepApi.models.list();
    $('model').innerHTML = list.data.map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  } catch (e) {
    log('[初始化失败] ' + (e?.message ?? JSON.stringify(e)));
  }
})();

document.querySelectorAll('button[data-act]').forEach(btn => {
  btn.addEventListener('click', async () => {
    reset();
    const act = btn.dataset.act;
    const m = model();
    const opts = baseOpts();
    btn.classList.add('busy'); btn.disabled = true;
    try {
      if (act === 'one') {
        const msgs = [{ role: 'user', content: '用一句话介绍 DeepSeek。' }];
        const r = await window.deepApi.chat.completions.create({ model: m, messages: msgs, ...opts });
        msgs.push({ role: 'assistant', content: r.choices[0].message.content });
        dump('非流式问答', msgs);
        dumpChoice('[非流式]', r.choices[0]);
      } else if (act === 'stream') {
        const msgs = [{ role: 'user', content: '用三句话讲讲 R1 推理模型。' }];
        const res = await window.deepApi.chat.completions.create({ model: m, messages: msgs, ...opts, stream: true });
        log('[流式开始；收到 SSE 帧：');
        // v0.1.49：bridge 改返 Response（body.getReader），用 TextDecoder 读字节流
        const reader = res.body.getReader();
        const dec = new TextDecoder('utf-8');
        let content = '', reasoning = '';
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // 按 \n\n 切帧；每帧形如 "data: {...json...}\n\n" 或 "data: [DONE]\n\n"
          let nl;
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
        // 网页端会看到两个 chat thread（这是设计行为，不是 bug）。需要“真正在同一 session 上修改历史”需走 DeepSeek 网页 UI 的“编辑”按钮或 v2 spike edit_message 端点。
        const m1 = [{ role: 'user', content: '2+2 等于几？' }];
        const a1 = [{ role: 'assistant', content: '4' }];
        const m2 = [{ role: 'user', content: '2+2 等于几？' }, { role: 'assistant', content: '五' }, { role: 'user', content: '再说一遍？' }];
        const r1 = await window.deepApi.chat.completions.create({ model: m, messages: m1.concat(a1), ...opts });
        log('[第一次调用]');
        dumpChoice('  [第一次]', r1.choices[0]);
        const r2 = await window.deepApi.chat.completions.create({ model: m, messages: m2, ...opts });
        log('[第二次调用（修改历史 rebuild，新 session）]');
        dump('  rebuild 后传入的 messages', m2);
        dumpChoice('  [第二次]', r2.choices[0]);
      } else if (act === 'conv') {
        const cid = 'demo-' + Date.now();
        // 多轮调用契约：messages 必须包含完整历史（仿 OpenAI SDK），不能只传新一条
        const history = [{ role: 'user', content: '记住数字 42。' }];
        const r1 = await window.deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
        history.push({ role: 'assistant', content: r1.choices[0].message.content });
        history.push({ role: 'user', content: '刚才那个数字是什么？' });
        const r2 = await window.deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
        history.push({ role: 'assistant', content: r2.choices[0].message.content });
        log('[conversation_id=' + cid + ']');
        dump('续聊完整历史', history);
        dumpChoice('  [第一轮]', r1.choices[0]);
        dumpChoice('  [第二轮]', r2.choices[0]);
      } else if (act === 'vision') {
        log('[vision] 未启用：deep.api 网页 web API 不支持 in-line image（详见面板说明）。');
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
        });
        const r = await window.deepApi.chat.completions.create({
          model: 'deepseek-v4-flash-vision-exp',
          messages: [{ role: 'user', content: [
            { type: 'text', text: $('imgQ').value || '描述图片' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] }],
          ...opts,
        });
        log('[vision] ' + r.choices[0].message.content);
      }
    } catch (e) {
      log('[错误] ' + (e?.message ?? JSON.stringify(e)));
    } finally {
      btn.classList.remove('busy'); btn.disabled = false;
    }
  });
});

async function runToolScenario(modelId, choice) {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: '取某地天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  let msgs = [{ role: 'user', content: '北京天气如何？' }];
  const opts = baseOpts();
  const r1 = await window.deepApi.chat.completions.create({ model: modelId, messages: msgs, tools, tool_choice: choice, ...opts });
  const tc = r1.choices[0].message.tool_calls?.[0];
  msgs.push({ role: 'assistant', content: r1.choices[0].message.content || null, tool_calls: tc ? [tc] : undefined });
  dump('[tool_choice=' + choice + '] 第一轮后历史', msgs);
  dumpChoice('  [第一轮]', r1.choices[0]);
  if (tc) {
    msgs.push({ role: 'tool', tool_call_id: tc.id, content: '晴 26°C 微风' });
    msgs.push({ role: 'user', content: '那明天呢？' });
    // 第二轮改 'auto'：required 是“必须调工具”强指令，会让模型在收到工具结果后仍然再调工具（而不是自然回答）。
    // 'auto' 让模型基于上下文自主决定（自然回答 / 再调都自然）。
    const r2 = await window.deepApi.chat.completions.create({ model: modelId, messages: msgs, tools, tool_choice: 'auto', ...opts });
    msgs.push({ role: 'assistant', content: r2.choices[0].message.content || null, tool_calls: r2.choices[0].message.tool_calls });
    dump('[tool_choice=' + choice + '] 第二轮后完整历史', msgs);
    dumpChoice('  [第二轮]', r2.choices[0]);
  } else {
    log('[第二轮] （跳过——第一轮未调用工具）');
  }
}
