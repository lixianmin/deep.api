#!/usr/bin/env node
// scripts/bump-version.mjs — 把 manifest.json 的 version 末位 +1
// 用法：node scripts/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'manifest.json');
const pkgPath = join(here, '..', 'package.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  console.error(`manifest.json version 不符合 semver (x.y.z): ${manifest.version}`);
  process.exit(1);
}

// 2026-09-11（fix/review-r1 C2）：先留存旧版本号——旧实现在覆盖 manifest.version 之后才打印，
// 输出恒为「新 → 新」（如 0.1.103 → 0.1.103），看不出这次 bump 从哪来。
const prev = manifest.version;
const [maj, min, pat] = prev.split('.').map(Number);
const next = `${maj}.${min}.${pat + 1}`;

// 同时同步两个文件
manifest.version = next;
pkg.version = next;

// manifest.json 两份：仓库根用于 diff/build.mjs 复制到 extension/、package.json；同步两边。
// 2026-09-11（fix/review-r1 C1）：extension/manifest.json 是构建产物（gitignored，build.mjs 每次
// 从根 manifest.json 复制覆盖），fresh clone / 删过 extension/ 时它不存在——旧实现直接 readFileSync
// 抛 ENOENT 让整个 bump 失败（连 package.json 都没 bump 成）。缺失/损坏一律跳过并明确提示，
// 不阻塞；根 manifest.json 才是真相源。
const extManifestPath = join(here, '..', 'extension', 'manifest.json');
const updatedFiles = ['manifest.json'];
try {
  const extManifest = JSON.parse(readFileSync(extManifestPath, 'utf8'));
  extManifest.version = next;
  writeFileSync(extManifestPath, JSON.stringify(extManifest, null, 2) + '\n');
  updatedFiles.push('extension/manifest.json');
} catch (e) {
  const reason = (e && e.code === 'ENOENT') ? '不存在（未 build）' : `无法读取/写入/解析（${e.message}）`;
  console.log(`跳过: extension/manifest.json ${reason}；下次 npm run build 会从根 manifest.json 覆盖`);
}
updatedFiles.push('package.json');

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`version: ${prev} → ${next}`);
console.log(`已更新: ${updatedFiles.join(', ')}`);
