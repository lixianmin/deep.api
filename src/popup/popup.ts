// popup.ts - 通过 port 与 SW 通信；只在 MV3 popup 内执行（chrome.* 在此文件中）
import { formatAuthState, snippetText } from './snippet';

const port = chrome.runtime.connect({ name: 'deepapi-panel' });
type PanelState = { apiKey?: string; providers?: Record<string, { poolSize: number; ttlMinutes: number; lastAuthStatus: { state: string; message?: string } }>; log?: Array<{ at: number; provider: string; model: string; ok: boolean; ms: number; error?: string }> };
let state: PanelState = {};

port.onMessage.addListener((m: any) => {
  if (m?.kind === 'state') { state = m.payload; render(); }
});

function send(kind: string, payload: unknown = {}) { port.postMessage({ kind, payload }); }

function render() {
  const provider = state.providers?.deepseek;
  const auth = provider?.lastAuthStatus;
  const authEl = document.getElementById('auth-state')!;
  if (auth) { const f = formatAuthState(auth as any); authEl.textContent = f.label; authEl.className = f.cls; }
  else { authEl.textContent = '检查中...'; authEl.className = 'bad'; }
  document.getElementById('api-key')!.textContent = state.apiKey ?? '';
  (document.getElementById('snippet') as HTMLTextAreaElement).value = state.apiKey ? snippetText(state.apiKey) : '';
  (document.getElementById('pool-size') as HTMLInputElement).value = String(provider?.poolSize ?? 2);
  (document.getElementById('ttl-min') as HTMLInputElement).value = String(provider?.ttlMinutes ?? 30);
  document.getElementById('model-list')!.textContent = 'deepseek-chat / deepseek-reasoner';
  const logEl = document.getElementById('log-list')!;
  logEl.innerHTML = (state.log ?? []).slice(-20).reverse().map(e =>
    `<li><span class="${e.ok ? 'ok' : 'err'}">${e.ok ? '✓' : '✗'}</span> ${new Date(e.at).toLocaleTimeString()} ${e.provider}/${e.model} ${e.ms}ms${e.error ? ' <span class="err">' + e.error + '</span>' : ''}</li>`
  ).join('');
}

document.getElementById('btn-login')!.addEventListener('click', () => send('panel.openLogin'));
document.getElementById('btn-copy-key')!.addEventListener('click', () => navigator.clipboard.writeText(state.apiKey ?? ''));
document.getElementById('btn-reset-key')!.addEventListener('click', () => send('panel.regenerateKey'));
document.getElementById('btn-copy-snippet')!.addEventListener('click', () => navigator.clipboard.writeText((document.getElementById('snippet') as HTMLTextAreaElement).value));
document.getElementById('pool-size')!.addEventListener('change', (e) => send('panel.setPool', { poolSize: Number((e.target as HTMLInputElement).value) }));
document.getElementById('ttl-min')!.addEventListener('change', (e) => send('panel.setTtl', { ttlMinutes: Number((e.target as HTMLInputElement).value) }));

send('panel.getState');
