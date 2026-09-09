# deep.api

把 DeepSeek 网页版转成 OpenAI 形态接口供其他网站调用（Chrome MV3 扩展）。

## 开发

```bash
npm install
npm run build           # esbuild 打包 + 复制资源 → extension/
npm test                # vitest run
npm run bump            # manifest.json / extension/manifest.json / package.json version 末位 +1
```

## 加载到 Chrome

1. `npm install` + `npm run build`（产物输出到 `extension/`）
2. 打开 `chrome://extensions/`，开"开发者模式"
3. "加载已解压的扩展程序" → 选仓库的 `extension/` 目录
4. 看到 `deep.api — DeepSeek web as OpenAI API`，确认状态为「已启用」

## 版本号同步

`npm run bump` 同时更新三个文件的 version 字段：

- `manifest.json`（仓库根，git tracked）
- `extension/manifest.json`（构建产物目录，gitignored；每次 `npm run build` 从根 `manifest.json` 复制覆盖）
- `package.json`（git tracked）

bump → build → 加载新版本，三步顺序不能反。

## 目录约定

- `extension/` —— Chrome 加载目录（gitignored，构建产物）
- `src/` —— TypeScript 源码
- `tests/` —— vitest
- `examples/demo-page/` —— popup 里"Open Demo in new window"弹窗用的 demo HTML+JS