// 2026-09-11（fix/review-r1 C1/C2）：bump 脚本的回归用例。
// 脚本按自身所在位置解析仓库布局，所以用「临时目录里放同一份脚本副本 + 最小仓库布局」跑真实 CLI，
// 既不污染仓库 version，又能覆盖 extension/manifest.json 存在/缺失/损坏三种状态。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/bump-version.mjs', import.meta.url));
const roots: string[] = [];

function fixture(opts: { extManifest?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bump-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(root, 'scripts', 'bump-version.mjs'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'x', version: '0.1.102' }, null, 2) + '\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.102' }, null, 2) + '\n');
  // extManifest: undefined = 用默认合法内容建文件；null = 不建 extension/（未 build 状态）；字符串 = 原样写入
  if (opts.extManifest !== null) {
    mkdirSync(join(root, 'extension'), { recursive: true });
    writeFileSync(join(root, 'extension', 'manifest.json'), opts.extManifest ?? JSON.stringify({ manifest_version: 3, name: 'x', version: '0.1.102' }, null, 2) + '\n');
  }
  return root;
}

function run(root: string) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'bump-version.mjs')], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { version: string };

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('scripts/bump-version.mjs', () => {
  it('C2：打印的旧版本号是覆盖前的真实旧值（不是 0.1.103 → 0.1.103）', () => {
    const root = fixture();
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0.1.102 → 0.1.103');
    expect(readJson(join(root, 'manifest.json')).version).toBe('0.1.103');
    expect(readJson(join(root, 'package.json')).version).toBe('0.1.103');
    expect(readJson(join(root, 'extension', 'manifest.json')).version).toBe('0.1.103');
  });

  it('C1：extension/manifest.json 不存在（未 build）时不崩，package.json / 根 manifest 照常 bump', () => {
    const root = fixture({ extManifest: null });
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('ENOENT');
    expect(r.stdout).toContain('跳过');
    expect(readJson(join(root, 'manifest.json')).version).toBe('0.1.103');
    expect(readJson(join(root, 'package.json')).version).toBe('0.1.103');
  });

  it('extension/manifest.json 内容损坏时同样跳过而不是崩（build 会覆盖它）', () => {
    const root = fixture({ extManifest: '{ this is not json' });
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('跳过');
    expect(readJson(join(root, 'package.json')).version).toBe('0.1.103');
  });

  it('根 manifest.json version 非 semver 时仍然报错退出（回归保护）', () => {
    const root = fixture();
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.2' }, null, 2) + '\n');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('semver');
    expect(readJson(join(root, 'package.json')).version).toBe('0.1.102');   // 未写坏
  });
});
