import { build } from 'esbuild';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const shared = { bundle: true, sourcemap: false, minify: true, target: 'es2022', logLevel: 'info' };

// v0.1.49：构建产物统一输出到 extension/（Chrome 直接加载这个目录）。
// 历史背景：曾用 dist/，但用户反复跟 Chrome 加载路径混淆；改回 extension/ 后，
// .gitignore 仍忽略 extension/（构建产物不入仓，用户 git pull 后跑 npm run build 再加载）。
await Promise.all([
  build({ ...shared, entryPoints: ['src/background/sw.ts'], outfile: 'extension/sw.js', format: 'esm' }),
  build({ ...shared, entryPoints: ['src/content/bridge-main.ts'], outfile: 'extension/bridge-main.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/content/bridge-relay.ts'], outfile: 'extension/bridge-relay.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/popup/popup.ts'], outfile: 'extension/popup.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/debug/demo-page/demo.js'], outfile: 'extension/debug/demo.js', format: 'iife', target: 'chrome120' }),
]);

await cp('src/popup/popup.html', 'extension/popup.html');
await cp('src/popup/popup.css', 'extension/popup.css');
// manifest.json 从仓库根复制到 extension/：Chrome 加载 extension/ 时以这里为准。
// 仓库根 manifest.json 也保留，方便 diff/查看；bundle/version 走脚本同步两端。
await cp('manifest.json', 'extension/manifest.json');
// 复制 demo 页到 extension/demo/，让 popup 能通过 chrome.runtime.getURL('demo/index.html') 在新窗口打开
await cp('src/debug/demo-page/index.html', 'extension/debug/index.html');
console.log('build + copy done');

// 验证 demo.js 是合法 ES2022+ JS（防 v0.1.44 那类 TS 语法泄漏到浏览器报 SyntaxError）
const tmp = await mkdtemp(join(tmpdir(), 'demo-syntax-'));
const scriptPath = join(tmp, 'demo.js');
await cp('src/debug/demo-page/demo.js', scriptPath);
try {
  execFileSync('node', ['--check', scriptPath], { stdio: 'inherit' });
  console.log('demo.js node --check: OK');
} finally {
  await rm(tmp, { recursive: true, force: true });
}