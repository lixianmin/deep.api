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

const [maj, min, pat] = manifest.version.split('.').map(Number);
const next = `${maj}.${min}.${pat + 1}`;

// 同时同步两个文件
manifest.version = next;
pkg.version = next;

// manifest.json 两份：仓库根用于 diff/build.mjs 复制到 extension/、package.json；同步两边。
const extManifestPath = join(here, '..', 'extension', 'manifest.json');
const extManifest = JSON.parse(readFileSync(extManifestPath, 'utf8'));
extManifest.version = next;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(extManifestPath, JSON.stringify(extManifest, null, 2) + '\n');

console.log(`version: ${manifest.version.replace(/^\d+\.\d+\./, (m) => m)} → ${next}`);
console.log(`已更新: manifest.json, extension/manifest.json, package.json`);
