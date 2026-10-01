#!/usr/bin/env node
// 从 src/icons/icon.svg 生成 4 个尺寸的 PNG 并提交入库。
//
// 为什么不放进 build.mjs：MV3 的 manifest 不接受 SVG，icons / default_icon 必须是 PNG，
// 但这 4 张图是静态产物、几乎不变。放进 build 只会给每次构建平添一个光栅化器依赖。
// 因此 SVG 是唯一真相源并入库，PNG 随仓库提交；只有改了 SVG 才需要手动重跑本脚本。
//
// 用 rsvg-convert（brew install librsvg）；找不到则回退到无头 Chrome 渲染
// ——本仓是 Chrome 扩展，Chrome 必然存在，所以回退路径不需要额外安装任何东西。
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(ROOT, 'src/icons/icon.svg');
const OUT_DIR = join(ROOT, 'src/icons/png');
// Chrome 工具栏/扩展管理页实际用到的尺寸；128 兼作商店与安装页的大图。
const SIZES = [16, 32, 48, 128];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function hasRsvg() {
  try {
    execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function renderWithRsvg(size) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-b', 'none', SVG, '-o', join(OUT_DIR, `icon-${size}.png`)], { stdio: 'inherit' });
}

function renderWithChrome(size) {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('未找到 Chrome，无法光栅化');
  const page = `data:text/html,<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="file://${SVG}">`;
  const out = join(OUT_DIR, `icon-${size}.png`);
  execFileSync(bin, ['--headless', '--disable-gpu', '--hide-scrollbars', `--default-background-color=00000000`, `--screenshot=${out}`, `--window-size=${size},${size}`, page], { stdio: 'ignore' });
}

if (!existsSync(SVG)) {
  console.error(`找不到 ${SVG}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });
const useRsvg = hasRsvg();
for (const size of SIZES) {
  if (useRsvg) renderWithRsvg(size);
  else renderWithChrome(size);
  console.log(`icon-${size}.png`);
}
console.log(useRsvg ? '生成完成（rsvg-convert）' : '生成完成（headless Chrome 回退）');
