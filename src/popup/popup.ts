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
const res = await window.deepApi.chat.completions.create({
  model: '${firstModel}',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const chunk of res) {
  if (chunk.choices[0].delta.content) process.stdout.write(chunk.choices[0].delta.content);
}`;
}

document.getElementById('btn-login')!.addEventListener('click', () => send('panel.openLogin'));
document.getElementById('btn-refresh-auth')!.addEventListener('click', () => send('panel.refreshAuth'));
document.getElementById('btn-copy-snippet')!.addEventListener('click', () => navigator.clipboard.writeText((document.getElementById('snippet') as HTMLTextAreaElement).value));
document.getElementById('pool-size')!.addEventListener('change', (e) => send('panel.setPool', { poolSize: Number((e.target as HTMLInputElement).value) }));
document.getElementById('ttl-min')!.addEventListener('change', (e) => send('panel.setTtl', { ttlMinutes: Number((e.target as HTMLInputElement).value) }));

send('panel.getState');
// 后台心跳：每 2s 主动拉一次最新状态（防御 SW 探测未完成时 popup 早开的情况）
setInterval(() => send('panel.getState'), 2000);