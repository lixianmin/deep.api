// popup.ts - 通过 port 与 SW 通信；只在 MV3 popup 内执行（chrome.* 在此文件中）
import { formatAuthState, pickForensicTail, renderLogListHtml, renderModelListHtml, type PopupLogEntry } from './snippet';

const port = chrome.runtime.connect({ name: 'deepapi-panel' });
type LogEntry = PopupLogEntry;
type PanelState = {
  providers?: Record<string, {
    poolSize?: number;
    ttlMinutes?: number;
    lastAuthStatus?: { state: string; message?: string };
    models?: Array<{ id: string; description: string }>;
  }>;
  log?: LogEntry[];
};
let state: PanelState = {};

port.onMessage.addListener((m: any) => {
  if (m?.kind === 'state') { state = m.payload; render(); }
});

function send(kind: string, payload: unknown = {}) { port.postMessage({ kind, payload }); }

// 2026-09-11（fix/review-r1）：2s 心跳的 render() 不得无条件重写 DOM。
// 旧实现每次都给 number input 回写 storage 值（用户正在输入时被吞字）、给日志列表重设 innerHTML
// （滚动位置被打回顶部）。只写变化过的控件。
function setInputValue(el: HTMLInputElement, value: string): void {
  if (document.activeElement === el) return;   // 用户正在编辑，不覆盖
  if (el.value !== value) el.value = value;
}
let lastModelListHtml = '';
let lastLogListHtml = '';

function render() {
  const provider = state.providers?.deepseek;
  const auth = provider?.lastAuthStatus;
  const authEl = document.getElementById('auth-state')!;
  if (auth) {
    const f = formatAuthState(auth as any);
    authEl.textContent = f.label;
    authEl.className = f.cls;
    authEl.title = auth.message ?? '';
  } else {
    authEl.textContent = '检查中...';
    // 2026-09-11（fix/review-r1）：初值不再写死红色错误态（popup.html 也同步改为中立文案）——
    // SW 冷启动期间已登录用户不该看到假「未登录」。
    authEl.className = '';
    authEl.title = '';
  }

  const snippet = document.getElementById('snippet') as HTMLTextAreaElement;
  snippet.value = snippetText();

  const models = provider?.models ?? [];
  const modelList = document.getElementById('model-list')!;
  const modelHtml = renderModelListHtml(models);
  if (modelHtml !== lastModelListHtml) { modelList.innerHTML = modelHtml; lastModelListHtml = modelHtml; }

  setInputValue(document.getElementById('pool-size') as HTMLInputElement, String(provider?.poolSize ?? 2));
  setInputValue(document.getElementById('ttl-min') as HTMLInputElement, String(provider?.ttlMinutes ?? 30));

  // v0.1.50 渲染决策现场：action 标色 + deletedOld 红警，让「每发一条消息重建一条」一眼可见
  // 2026-09-11（fix/review-r1）：整块 HTML 由 renderLogListHtml 生成（全部字段已转义）；
  // 内容未变就不重设 innerHTML。
  const logEl = document.getElementById('log-list')!;
  const entries = state.log ?? [];
  const logHtml = renderLogListHtml(entries.slice(-200).reverse());
  if (logHtml !== lastLogListHtml) { logEl.innerHTML = logHtml; lastLogListHtml = logHtml; }

  // Tab 高度同步（v0.1.62）：三 panel 中最高者作 min-height，避免切换时整体跳动
  syncTabHeight();
}

function snippetText(): string {
  // 默认取第一个模型；用户可在自己的网站代码里覆盖
  // 2026-09-11（fix/review-r1）：models 为空数组时 `[0]!.id` 会抛 TypeError（render() 整个挂掉）；
  // 改用可选链 + 当前默认模型 id 作为兑底。
  const firstModel = state.providers?.deepseek?.models?.[0]?.id ?? 'deepseek-flash';
  return `// deep.api 接入：本机桥接，无需 API Key
// 多轮对话测试：每轮把完整历史（含上一轮回复）传给 messages，上下文自动续接
let history = [{ role: 'user', content: '你好，我叫小明' }];
let r1 = await window.deepApi.chat.completions.create({ model: '${firstModel}', messages: history });
console.log('第一轮:', r1.choices[0].message.content);

history = [...history, { role: 'assistant', content: r1.choices[0].message.content }, { role: 'user', content: '我叫什么名字？' }];
let r2 = await window.deepApi.chat.completions.create({ model: '${firstModel}', messages: history });
console.log('第二轮:', r2.choices[0].message.content);
`;
}

// 09-10（用户拍板）：原「打开登录页」+ 「重新同步」两按钮合一。点击先 openLogin（新 tab 立即视觉反馈，
// 且新 tab 靠 manifest content_scripts 自动注入 bridge），再 resyncAuth（SW 串行处理，对已开的
// chat.deepseek.com tab 重新注入 bridge-main.js 并重探登录态）。发送顺序即 SW 处理顺序。
document.getElementById('btn-resync-auth')!.addEventListener('click', () => {
  send('panel.openLogin');
  send('panel.resyncAuth');
});
document.getElementById('btn-copy-snippet')!.addEventListener('click', () => navigator.clipboard.writeText((document.getElementById('snippet') as HTMLTextAreaElement).value));
// 2026-09-11（fix/review-r1）：空值/0 不发（Number('') === 0）；值夹取到合法区间（SW 也会再夹一次）。
function readClampedInput(el: HTMLInputElement, min: number, max: number): number | null {
  const n = Number(el.value);
  if (!Number.isFinite(n) || n < min) return null;
  return Math.min(max, Math.floor(n));
}
document.getElementById('pool-size')!.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const n = readClampedInput(input, 1, 5);
  if (n === null) { input.value = String(state.providers?.deepseek?.poolSize ?? 2); return; }
  send('panel.setPool', { poolSize: n });
});
document.getElementById('ttl-min')!.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const n = readClampedInput(input, 1, 1440);
  if (n === null) { input.value = String(state.providers?.deepseek?.ttlMinutes ?? 30); return; }
  send('panel.setTtl', { ttlMinutes: n });
});

// 2026-09-11（fix/review-r1）：按钮文案用常量，不从「可能已被上次闪现改写」的 textContent 读回
// （1.5s 内连点两次会把闪现文案当成原文恢复，按钮永久显示「已复制 N 条」）。
const COPY_LOG_LABEL = '复制';
const COPY_FORENSIC_LABEL = '复制取证';

// 2026-09-09（feat/diagnostic-logging）：复制最近 200 条日志为 JSON，贴给 AI / 自己排查
document.getElementById('btn-copy-log')!.addEventListener('click', () => {
  const entries = (state.log ?? []).slice(-200);
  const text = JSON.stringify(entries, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy-log') as HTMLButtonElement;
    btn.textContent = `已复制 ${entries.length} 条`;
    setTimeout(() => { btn.textContent = COPY_LOG_LABEL; }, 1500);
  }).catch((e) => {
    console.error('[deep.api popup] 复制日志失败', e);
  });
});

// 2026-09-10（feat/log-b64-export + fix/forensic-tail）：复制**最近 5 条**的取证字段。
// 不用「最新一条」：Spice 一轮会发多次请求（聊天调用之后还有「生成会话标题」辅助调用），
// 最新一条往往不是出问题的那一条（v0.1.100 实测取到标题调用，里面根本没有 DSML）。
// 也不用「复制」按钮的 200 条完整日志（含 messagesFull / mirrorFull，可达 MB，贴给 AI 不现实）。
document.getElementById('btn-copy-forensic')!.addEventListener('click', () => {
  const btn = document.getElementById('btn-copy-forensic') as HTMLButtonElement;
  const flash = (msg: string): void => {
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = COPY_FORENSIC_LABEL; }, 1500);
  };
  const tail = (state.log ?? []).slice(-5) as unknown as Record<string, unknown>[];
  if (!tail.length) { flash('没有日志'); return; }
  navigator.clipboard.writeText(JSON.stringify(pickForensicTail(tail), null, 2))
    .then(() => flash(`已复制 ${tail.length} 条 v${String(tail[tail.length - 1]!.version ?? '?')}`))
    .catch((e) => { console.error('[deep.api popup] 复制取证失败', e); });
});

// "Open Debug in new tab" 按钮：chrome-extension:// 协议代替 file://（Chrome 扩展开不了 file://）
// debug HTML 在 build.mjs 复制到 extension/debug/index.html；通过 web_accessible_resources 暴露
// 用 chrome.tabs.create 弹新 tab（不是新 window），与浏览器其他 tab 一致
document.getElementById('btn-open-debug')!.addEventListener('click', () => {
  const url = chrome.runtime.getURL('debug/index.html');
  chrome.tabs.create({ url });
});

send('panel.getState');
// 读取同目录的 manifest.json 显示版本号
fetch(chrome.runtime.getURL('manifest.json')).then(r => r.json()).then(m => {
  document.getElementById('version')!.textContent = 'v' + m.version;
}).catch(() => {});

// 后台心跳：每 2s 主动向 SW 请求完整 state（SW 是 storage 的唯一权威）。
// popup 不再直读 chrome.storage，避免心跳读到与 popup state 不一致的中间态。
function refresh() {
  send('panel.getState');
}
refresh();
setInterval(refresh, 2000);

// Tab 切换（v0.1.61 popup 重构）：监听 .tab-btn click，切换 .active class。
// HTML 已预置第一个 panel/btn 为 active，无需默认 click()。
setupTabs();
function setupTabs(): void {
  const btns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  for (const btn of btns) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      for (const b of btns) b.classList.toggle('active', b === btn);
      for (const p of panels) p.classList.toggle('active', p.dataset.tabPanel === target);
    });
  }
}

// Tab 高度同步（v0.1.62）：取三 panel 中最高 scrollHeight，设所有 panel min-height。
// 隐藏 panel 测量时临时移出屏幕外（visibility:hidden + position:absolute + left:-9999px），保持视觉无闪烁。
function syncTabHeight(): void {
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  let max = 0;
  panels.forEach(p => {
    // 2026-09-11（fix/review-r1）：测量前先清掉上一轮写的 min-height——否则元素自己的 min-height
    // 会把本轮 scrollHeight 抬高，max 单调不减（日志变少后永久留一块空白）。
    p.style.minHeight = '';
    const wasActive = p.classList.contains('active');
    if (!wasActive) {
      p.style.visibility = 'hidden';
      p.style.display = 'block';
      p.style.position = 'absolute';
      p.style.left = '-9999px';
      // absolute 定位下 width:auto 走 shrink-to-fit，隐藏 panel 的换行/高度都不真实——补 width。
      p.style.width = '100%';
    }
    const h = p.scrollHeight;
    if (h > max) max = h;
    if (!wasActive) {
      p.style.visibility = '';
      p.style.display = '';
      p.style.position = '';
      p.style.left = '';
      p.style.width = '';
    }
  });
  panels.forEach(p => { p.style.minHeight = max + 'px'; });
}