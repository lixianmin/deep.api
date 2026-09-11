# deep.api

把 DeepSeek 网页版转成 OpenAI 形态接口供其他网站调用（Chrome MV3 扩展）。

## 开发

依赖用 [bun](https://bun.sh) 管理（lockfile 是 `bun.lock`；`npm/pnpm install` 会被 preinstall 拒绝）：

```bash
bun install
bun run build           # esbuild 打包 + 复制资源 → extension/
bun run test            # vitest run（注意：bun test 是 bun 自带 runner，不是 vitest）
bun run bump            # manifest.json / extension/manifest.json / package.json version 末位 +1
```

## 加载到 Chrome

1. `bun install` + `bun run build`（产物输出到 `extension/`）
2. 打开 `chrome://extensions/`，开"开发者模式"
3. "加载已解压的扩展程序" → 选仓库的 `extension/` 目录
4. 看到 `deep.api — DeepSeek web as OpenAI API`，确认状态为「已启用」

## 版本号同步

`bun run bump` 同时更新三个文件的 version 字段：

- `manifest.json`（仓库根，git tracked）
- `extension/manifest.json`（构建产物目录，gitignored；每次 `bun run build` 从根 `manifest.json` 复制覆盖）
- `package.json`（git tracked）

bump → build → 加载新版本，三步顺序不能反。

## 目录约定

- `extension/` —— Chrome 加载目录（gitignored，构建产物）
- `src/` —— TypeScript 源码
- `tests/` —— vitest
- `src/debug/demo-page/` —— popup 里"Open Demo in new tab"弹窗用的 demo HTML+JS（v0.1.61 起从 examples/demo-page/ 迁入；`bun run build` 输出到 `extension/debug/`）