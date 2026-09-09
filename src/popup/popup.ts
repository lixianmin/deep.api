// popup.ts - 通过 port 与 SW 通信；只在 MV3 popup 内执行（chrome.* 在此文件中）
import { formatAuthState } from './snippet';

const port = chrome.runtime.connect({ name: 'deepapi-panel' });
type PanelState = {
  providers?: Record<string, {
    poolSize?: number;
    ttlMinutes?: number;
    lastAuthStatus?: { state: string; message?: string };
    models?: Array<{ id: string; description: string }>;
  }>;
  log?: Array<{ at: number; provider: string; model: string; ok: boolean; ms: number; error?: string }>;
};
let state: PanelState = {};

port.onMessage.addListener((m: any) => {
  if (m?.kind === 'state') { state = m.payload; render(); }
});

function send(kind: string, payload: unknown = {}) { port.postMessage({ kind, payload }); }

function render() {
  console.log('[deep.api popup] render, state:', JSON.stringify(state).slice(0, 200));
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

  const logEl = document.getElementById('log-list')!;
  logEl.innerHTML = (state.log ?? []).slice(-20).reverse().map(e =>
    `<li><span class="${e.ok ? 'ok' : 'err'}">${e.ok ? '✓' : '✗'}</span> ${new Date(e.at).toLocaleTimeString()} ${e.provider}/${e.model} ${e.ms}ms${e.error ? ' <span class="err">' + e.error + '</span>' : ''}</li>`
  ).join('');
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
document.getElementById('btn-refresh-auth')!.addEventListener('click', () => send('panel.refreshAuth'));
document.getElementById('btn-repush-auth')!.addEventListener('click', () => send('panel.repushAuth'));
document.getElementById('btn-copy-snippet')!.addEventListener('click', () => navigator.clipboard.writeText((document.getElementById('snippet') as HTMLTextAreaElement).value));
document.getElementById('pool-size')!.addEventListener('change', (e) => send('panel.setPool', { poolSize: Number((e.target as HTMLInputElement).value) }));
document.getElementById('ttl-min')!.addEventListener('change', (e) => send('panel.setTtl', { ttlMinutes: Number((e.target as HTMLInputElement).value) }));

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
  console.log('[deep.api popup] heartbeat → panel.getState');
  send('panel.getState');
}
refresh();
setInterval(refresh, 2000);
