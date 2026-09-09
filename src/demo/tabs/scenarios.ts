// src/demo/tabs/scenarios.ts
import type { LogEntry } from '../../background/log';

export interface ScenarioResult { name: string; ok: boolean; ms: number; error?: string; output?: string; }

// === 6 个场景函数（与 src/demo/demo-page/demo.js:128-258 1:1 等价） ===

async function oneShot(m: string, opts: any): Promise<string> {
  const msgs = [{ role: 'user', content: '用一句话介绍 DeepSeek。' }];
  const r = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts });
  msgs.push({ role: 'assistant', content: r.choices[0].message.content });
  return JSON.stringify(msgs);
}

async function stream(m: string, opts: any): Promise<string> {
  const msgs = [{ role: 'user', content: '用三句话讲讲 R1 推理模型。' }];
  const res = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts, stream: true });
  const reader = res.body.getReader();
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
        if (d?.content) content += d.content;
      } catch { /* ignore malformed frame */ }
    }
  }
  msgs.push({ role: 'assistant', content });
  return JSON.stringify(msgs);
}

async function runTool(m: string, opts: any, choice: 'auto' | 'required'): Promise<string> {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: '取某地天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const msgs: any[] = [{ role: 'user', content: '北京天气如何？' }];
  const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, tools, tool_choice: choice, ...opts });
  const tc = r1.choices[0].message.tool_calls?.[0];
  msgs.push({ role: 'assistant', content: r1.choices[0].message.content || null, ...(tc ? { tool_calls: [tc] } : {}) });
  if (tc) {
    msgs.push({ role: 'tool', tool_call_id: tc.id, content: '晴 26°C 微风' });
    msgs.push({ role: 'user', content: '那明天呢？' });
    const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, tools, tool_choice: 'auto', ...opts });
    msgs.push({ role: 'assistant', content: r2.choices[0].message.content || null, ...(r2.choices[0].message.tool_calls ? { tool_calls: r2.choices[0].message.tool_calls } : {}) });
  }
  return JSON.stringify(msgs);
}
const toolAuto     = (m: string, opts: any) => runTool(m, opts, 'auto');
const toolRequired = (m: string, opts: any) => runTool(m, opts, 'required');

async function rebuild(m: string, opts: any): Promise<string> {
  // 第一轮：user '2+2 等于几？' → assistant '4'
  const m1 = [{ role: 'user', content: '2+2 等于几？' }];
  const a1 = [{ role: 'assistant', content: '4' }];
  await (window as any).deepApi.chat.completions.create({ model: m, messages: m1.concat(a1), ...opts });
  // 第二轮：修改历史 assistant '4' → '五' → mirror 不匹配 → rebuild
  const m2 = [{ role: 'user', content: '2+2 等于几？' }, { role: 'assistant', content: '五' }, { role: 'user', content: '再说一遍？' }];
  const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: m2, ...opts });
  return JSON.stringify({ first: m1.concat(a1), second: m2, second_choice: r2.choices[0] });
}

async function conv(m: string, opts: any): Promise<string> {
  const cid = 'demo-' + Date.now();
  const history: any[] = [{ role: 'user', content: '记住数字 42。' }];
  const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
  history.push({ role: 'assistant', content: r1.choices[0].message.content });
  history.push({ role: 'user', content: '刚才那个数字是什么？' });
  const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
  history.push({ role: 'assistant', content: r2.choices[0].message.content });
  return JSON.stringify({ cid, history });
}

const SCENARIOS: Array<{ name: string; run: (m: string, opts: any) => Promise<string> }> = [
  { name: '非流式问答',              run: oneShot },
  { name: '流式问答',                run: stream },
  { name: '工具调用 (auto)',         run: toolAuto },
  { name: '工具调用 (required)',     run: toolRequired },
  { name: '修改历史重发 (rebuild)',  run: rebuild },
  { name: 'conversation_id 续聊',    run: conv },
];

export async function runAllScenarios(modelId: string, opts: any, isCancelRequested: () => boolean): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const sc of SCENARIOS) {
    if (isCancelRequested()) break;
    const t0 = Date.now();
    try {
      const output = await sc.run(modelId, opts);
      results.push({ name: sc.name, ok: true, ms: Date.now() - t0, output });
    } catch (e: any) {
      results.push({ name: sc.name, ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) });
    }
  }
  return results;
}

export function mountScenarios(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <div style="margin-bottom:8px;">
      <label>model <select data-sc-model></select></label>
      <button data-run-one>非流式问答</button>
      <button data-run-stream>流式问答</button>
      <button data-run-tool-auto>工具调用 (auto)</button>
      <button data-run-tool-required>工具调用 (required)</button>
      <button data-run-rebuild>修改历史重发 (rebuild)</button>
      <button data-run-conv>conversation_id 续聊</button>
      <button data-run-all style="margin-left:12px;background:#e0f0e0;">全部跑</button>
      <button data-cancel style="display:none;background:#fdd;">取消</button>
    </div>
    <table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px;">
      <thead><tr><th>场景</th><th>通过</th><th>耗时</th><th>错误</th></tr></thead>
      <tbody data-tbody></tbody>
    </table>
  `;
  const modelSel  = pane.querySelector<HTMLSelectElement>('[data-sc-model]')!;
  const tbody     = pane.querySelector<HTMLTableSectionElement>('[data-tbody]')!;
  const runAllBtn = pane.querySelector<HTMLButtonElement>('[data-run-all]')!;
  const cancelBtn = pane.querySelector<HTMLButtonElement>('[data-cancel]')!;

  const singleBtns: Array<[string, string, () => Promise<string>]> = [
    ['data-run-one',          '非流式问答',                () => oneShot(modelSel.value, baseOpts())],
    ['data-run-stream',       '流式问答',                  () => stream(modelSel.value, baseOpts())],
    ['data-run-tool-auto',    '工具调用 (auto)',           () => toolAuto(modelSel.value, baseOpts())],
    ['data-run-tool-required','工具调用 (required)',       () => toolRequired(modelSel.value, baseOpts())],
    ['data-run-rebuild',      '修改历史重发 (rebuild)',    () => rebuild(modelSel.value, baseOpts())],
    ['data-run-conv',         'conversation_id 续聊',     () => conv(modelSel.value, baseOpts())],
  ];

  // v1 简化：scenarios tab 用 deep.api 默认值（thinking=true, reasoning=high），不在 UI 暴露控件
  // ——避免与 Chat tab 顶栏控件状态漂移。后续如需暴露，把控件设为可见。
  const searchCb = pane.appendChild(document.createElement('input'));
  searchCb.type = 'checkbox'; searchCb.style.display = 'none';
  const baseOpts = (): any => {
    const o: any = {};
    if (searchCb.checked) o.search = true;
    return o;
  };

  // 加载模型列表
  (window as any).deepApi.models.list().then((r: any) => {
    modelSel.innerHTML = (r.data as any[]).map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  }).catch(() => {});

  // 单行渲染：<tr><td colspan=4><details><summary>...</summary><pre>...</pre></details></td></tr>
  // ——<thead> 列对齐保留，<details> 原生 click 展开，零 JS 切换。spec §场景 tab「点击行展开原始输出」。
  const appendRow = (r: ScenarioResult): void => {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.style.padding = '0';
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.style.cursor = 'pointer';
    sum.style.padding = '4px';
    if (!r.ok) sum.style.background = '#fee';
    sum.innerHTML =
      `<span style="display:inline-block;width:35%;vertical-align:top;">${r.name}</span>` +
      `<span style="display:inline-block;width:10%;text-align:center;vertical-align:top;">${r.ok ? '✓' : '✗'}</span>` +
      `<span style="display:inline-block;width:15%;vertical-align:top;">${r.ms}ms</span>` +
      `<span style="display:inline-block;vertical-align:top;">${r.error ?? ''}</span>`;
    det.appendChild(sum);
    const detail = r.output ?? r.error;
    if (detail) {
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:8px 12px;font-size:11px;background:#fafafa;border-top:1px solid #eee;white-space:pre-wrap;word-break:break-word;';
      pre.textContent = detail;
      det.appendChild(pre);
    }
    td.appendChild(det);
    tr.appendChild(td);
    tbody.appendChild(tr);
  };

  // 6 个单按钮
  for (const [sel, friendlyName, fn] of singleBtns) {
    pane.querySelector(`[${sel}]`)!.addEventListener('click', async () => {
      tbody.innerHTML = '';
      const t0 = Date.now();
      try { appendRow({ name: friendlyName, ok: true, ms: Date.now() - t0, output: await fn() }); }
      catch (e: any) { appendRow({ name: friendlyName, ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) }); }
    });
  }

  // 「全部跑」按钮 + 取消
  let cancelFlag = false;
  runAllBtn.addEventListener('click', async () => {
    tbody.innerHTML = '';
    cancelFlag = false;
    runAllBtn.style.display = 'none';
    cancelBtn.style.display = '';
    const results = await runAllScenarios(modelSel.value, baseOpts(), () => cancelFlag);
    for (const r of results) appendRow(r);
    runAllBtn.style.display = '';
    cancelBtn.style.display = 'none';
  });
  cancelBtn.addEventListener('click', () => { cancelFlag = true; });

  return () => { pane.innerHTML = ''; };
}
