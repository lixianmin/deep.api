import type { AuthStatus } from '../background/providers/adapter';

export function formatAuthState(s: AuthStatus): { label: string; cls: 'ok' | 'warn' | 'bad' } {
  if (s.state === 'logged_in') return { label: '已登录', cls: 'ok' };
  if (s.state === 'expired') return { label: `已过期: ${s.message}`, cls: 'warn' };
  return { label: '未登录', cls: 'bad' };
}

export function snippetText(apiKey: string): string {
  return `// deep.api 接入：仅一段配置 + 一个调用
window.deepApiConfig = { apiKey: '${apiKey}' };

const res = await window.deepApi.chat.completions.create({
  model: 'deepseek-chat',            // 或 deepseek-reasoner（开启 thinking）
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const chunk of res) {
  if (chunk.choices[0].delta.content) process.stdout.write(chunk.choices[0].delta.content);
}
`;
}
