// popup.ts - 通过 port 与 SW 通信；只在 MV3 popup 内执行（chrome.* 在此文件中）
import { formatAuthState } from './snippet';

const port = chrome.runtime.connect({ name: 'deepapi-panel' });
type LogEntry = {
  at: number;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
  // v0.1.50 诊断字段
  cid?: string;
  msgsLen?: number;
  action?: 'rebuild' | 'incremental' | 'error';
  threadFound?: boolean;
  mirrorPrefixOk?: boolean;
  mirrorLen?: number;
  deletedOld?: boolean;
  webSessionId?: string;
  parentMessageId?: string | number | null;
  finishReason?: string;
  // v0.1.52（fix/mirror-content）：mirror 匹配失败现场
  firstDiffIdx?: number;
  firstDiffDetail?: string;
  messagesSample?: string;
  mirrorSample?: string;
};
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
    authEl.className = 'bad';
    authEl.title = '';
  }

  const snippet = document.getElementById('snippet') as HTMLTextAreaElement;
  snippet.value = snippetText();

  const models = provider?.models ?? [];
  const modelList = document.getElementById('model-list')!;
  modelList.innerHTML = models.length
    ? models.map(m => `<li><code>${m.id}</code> <span class="small">${m.description}</span></li>`).join('')
    : '<li class="small">（需登录后获取）</li>';

  (document.getElementById('pool-size') as HTMLInputElement).value = String(provider?.poolSize ?? 2);
  (document.getElementById('ttl-min') as HTMLInputElement).value = String(provider?.ttlMinutes ?? 30);

  // v0.1.50 渲染决策现场：action 标色 + deletedOld 红警，让「每发一条消息重建一条」一眼可见
  const logEl = document.getElementById('log-list')!;
  const entries = state.log ?? [];
  logEl.innerHTML = entries.slice(-200).reverse().map(e => {
    const okCls = e.ok ? 'ok' : 'err';
    const okMark = e.ok ? '✓' : '✗';
    const actionBadge = e.action === 'incremental' ? '<span class="ok">增量</span>'
      : e.action === 'rebuild' ? `<span class="err">重建</span>${e.deletedOld ? ' <span class="err" title="rebuild 删了旧 web session">🗑️</span>' : ''}`
      : '';
    const detailParts: string[] = [];
    if (e.cid) detailParts.push(`cid=${e.cid}`);
    if (e.threadFound === false) detailParts.push('<span class="err">thread 未找到</span>');
    if (e.mirrorPrefixOk === false) detailParts.push('<span class="err">mirror 不匹配</span>');
    if (e.mirrorLen !== undefined) detailParts.push(`mirrorLen=${e.mirrorLen}`);
    if (e.msgsLen !== undefined) detailParts.push(`msgs=${e.msgsLen}`);
    if (e.webSessionId) detailParts.push(`web=${e.webSessionId.slice(0, 8)}…`);
    if (e.parentMessageId !== undefined && e.parentMessageId !== null) detailParts.push(`parent=${String(e.parentMessageId).slice(0, 8)}`);
    if (e.finishReason) detailParts.push(`finish=${e.finishReason}`);
    if (e.error) detailParts.push(`<span class="err">err=${e.error.slice(0, 80)}</span>`);
    if (e.firstDiffIdx !== undefined) detailParts.push(`<span class="err" title="${(e.firstDiffDetail ?? '').replace(/"/g, '&quot;')}">diff@${e.firstDiffIdx}</span>`);
    return `<li><span class="${okCls}">${okMark}</span> ${new Date(e.at).toLocaleTimeString()} ${e.provider}/${e.model} ${e.ms}ms ${actionBadge} <span class="small">${detailParts.join(' ')}</span></li>`;
  }).join('');

  // Tab 高度同步（v0.1.62）：三 panel 中最高者作 min-height，避免切换时整体跳动
  syncTabHeight();
}

function snippetText(): string {
  // 默认取第一个模型；用户可在自己的网站代码里覆盖
  const firstModel = (state.providers?.deepseek?.models ?? [{ id: 'deepseek-v4-flash' }])[0]!.id;
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

document.getElementById('btn-login')!.addEventListener('click', () => send('panel.openLogin'));
document.getElementById('btn-resync-auth')!.addEventListener('click', () => send('panel.resyncAuth'));
document.getElementById('btn-copy-snippet')!.addEventListener('click', () => navigator.clipboard.writeText((document.getElementById('snippet') as HTMLTextAreaElement).value));
document.getElementById('pool-size')!.addEventListener('change', (e) => send('panel.setPool', { poolSize: Number((e.target as HTMLInputElement).value) }));
document.getElementById('ttl-min')!.addEventListener('change', (e) => send('panel.setTtl', { ttlMinutes: Number((e.target as HTMLInputElement).value) }));

// 2026-09-09（feat/diagnostic-logging）：复制最近 200 条日志为 JSON，贴给 AI / 自己排查
document.getElementById('btn-copy-log')!.addEventListener('click', () => {
  const entries = (state.log ?? []).slice(-200);
  const text = JSON.stringify(entries, null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy-log') as HTMLButtonElement;
    const orig = btn.textContent;
    btn.textContent = `已复制 ${entries.length} 条`;
    setTimeout(() => { btn.textContent = orig ?? '复制'; }, 1500);
  }).catch((e) => {
    console.error('[deep.api popup] 复制日志失败', e);
  });
});

// "Open Demo in new tab" 按钮：chrome-extension:// 协议代替 file://（Chrome 扩展开不了 file://）
// demo HTML 在 build.mjs 复制到 extension/demo/index.html；通过 web_accessible_resources 暴露
// 用 chrome.tabs.create 弹新 tab（不是新 window），与浏览器其他 tab 一致
document.getElementById('btn-open-demo')!.addEventListener('click', () => {
  const url = chrome.runtime.getURL('demo/index.html');
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
    const wasActive = p.classList.contains('active');
    if (!wasActive) {
      p.style.visibility = 'hidden';
      p.style.display = 'block';
      p.style.position = 'absolute';
      p.style.left = '-9999px';
    }
    const h = p.scrollHeight;
    if (h > max) max = h;
    if (!wasActive) {
      p.style.visibility = '';
      p.style.display = '';
      p.style.position = '';
      p.style.left = '';
    }
  });
  panels.forEach(p => { p.style.minHeight = max + 'px'; });
}