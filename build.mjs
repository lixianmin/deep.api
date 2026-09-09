import { build } from 'esbuild';
import { cp, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shared = { bundle: true, sourcemap: false, minify: true, target: 'es2022', logLevel: 'info' };

// build demo bundle if it has its own entry; otherwise popup bundle re-uses the same chunks via shared module
await Promise.all([
  build({ ...shared, entryPoints: ['src/background/sw.ts'], outfile: 'dist/sw.js', format: 'esm' }),
  build({ ...shared, entryPoints: ['src/content/bridge-main.ts'], outfile: 'dist/bridge-main.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/content/bridge-relay.ts'], outfile: 'dist/bridge-relay.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js', format: 'iife' }),
]);

await cp('src/popup/popup.html', 'dist/popup.html');
await cp('src/popup/popup.css', 'dist/popup.css');
// 复制 demo 页到 dist/demo/，让 popup 能通过 chrome.runtime.getURL('demo/index.html') 在新窗口打开
await cp('examples/demo-page/index.html', 'dist/demo/index.html');
console.log('build + copy done');

// 验证 demo 页 <script> 是合法 ES2022+ JS（防 v0.1.44 那类 TS 语法泄漏到 HTML 浏览器报 SyntaxError）
const demoHtml = await readFile('examples/demo-page/index.html', 'utf8');
const m = demoHtml.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('demo page has no <script> block');
const tmp = await mkdtemp(join(tmpdir(), 'demo-syntax-'));
const scriptPath = join(tmp, 'demo.js');
await writeFile(scriptPath, m[1], 'utf8');
try {
  execFileSync('node', ['--check', scriptPath], { stdio: 'inherit' });
  console.log('demo page <script> node --check: OK');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
