# Popup 重组为 Tab 结构 + demo 源迁移

日期：2026-09-09 · 状态：待评审 · 版本：v0.1.61 起

## 1. 背景与目标

当前 popup.html 平铺 6 个 section（登录状态、snippet、模型、配置、日志、Demo 按钮），内容变多后滚动距离长，配置/日志两类信息密度不高但挤在一起，用户找东西费劲。

本次重构目标：

- popup 顶部加水平 Tab 栏，把信息拆成「主页 / 设置 / 日志」三类。
- **Open Demo 按钮保留**：点击开新 tab 加载 `extension/demo/index.html`（行为不变）。
- 顺便清理 demo 源位置：`examples/demo-page/` 迁到 `src/demo/demo-page/`，让 demo 源码与 popup 源码在 src/ 下集中。

不在本次范围：

- 不内嵌 demo 到 popup（保留按钮开新 tab 模式）。
- 不动 SW `panel.*` 协议。
- 不动 demo 内容本身（HTML/JS 字节级不变，只搬路径）。
- 不加键盘快捷键、不加 Tab 状态持久化。

## 2. 术语

| 词 | 含义 |
|---|---|
| Tab 栏 | popup 顶部一行水平 tab 按钮（[主页] [设置] [日志]） |
| Panel | 每个 Tab 对应的内容容器，一次只显示一个 |
| 默认 Tab | popup 打开时显示的 Tab，本次固定为「主页」 |

## 3. 总体改动

涉及三类改动：

1. **popup UI 重构**：popup.html 拆 Tab；popup.css 加 Tab 样式；popup.ts 加 Tab 切换函数。
2. **demo 源迁移**：`examples/demo-page/` → `src/demo/demo-page/`；build.mjs 改拷贝源；删 examples/demo-page/。
3. **文档同步**：README 目录约定更新；memory 文件索引更新。

## 4. Popup 结构

### 4.1 视觉布局

```
┌──────────────────────────────────────┐
│ deep.api v0.1.61                     │  ← header（保留现有样式）
├──────────────────────────────────────┤
│ [主页] [设置] [日志]                   │  ← 顶部水平 Tab 栏
├──────────────────────────────────────┤
│                                      │
│ <Tab Panel>（一次只一个可见）         │
│                                      │
└──────────────────────────────────────┘
```

### 4.2 Tab 与 Panel 内容映射

| Tab | Panel 内容 | 数据来源 |
|---|---|---|
| 主页（默认） | 接入 snippet（textarea + 复制 snippet 按钮）、模型列表、Open Demo 按钮 | `state.providers.deepseek.models`、`snippetText()` |
| 设置 | 登录状态卡片（auth-state + 刷新/同步按钮 + 打开登录页）、配置（线程池、TTL） | `state.providers.deepseek.lastAuthStatus`、`provider.poolSize`、`provider.ttlMinutes` |
| 日志 | 复制按钮 + 说明文案 + 日志列表 | `state.log` |

### 4.3 Tab 切换行为

- 默认 Tab：**主页**。
- 切换方式：点击 Tab 按钮触发 JS 切换（监听 click）。
- 持久化：**不持久化**，每次打开 popup 回到「主页」。
- 切换后：被切走的 Panel `display: none`，切到的 Panel `display: block`，Tab 按钮 `.active` class 切换。
- 键盘 a11y：暂不实现（YAGNI；后续要加再补）。
- 心跳/数据更新：`panel.getState` 2s 一次心跳不变，三 Panel 内容都按当前数据重渲染（无论哪个 Panel 当前可见）。

### 4.4 Tab 实现方式（JS 驱动）

- HTML：`<nav class="tab-bar">` 包三个 `<button class="tab-btn" data-tab="home|settings|logs">`；三个 `<section class="tab-panel" data-tab-panel="home|settings|logs">`。
- CSS：`.tab-bar` 水平 flex；`.tab-btn.active` 加底色/下划线区分；`.tab-panel:not(.active)` `display: none`。
- JS：`setupTabs()` 函数，监听所有 `.tab-btn` click，切换 active class。

伪代码：

```ts
function setupTabs() {
  const btns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => p.classList.toggle('active', p.dataset.tabPanel === target));
    });
  });
  // 默认激活「主页」
  btns[0]?.click();
}
```

调用时机：DOMContentLoaded 后调用一次（现有 popup.ts 没有显式 DOMContentLoaded 包裹，因为 `<script src="popup.js">` 在 body 末尾；同样位置调用即可）。

### 4.5 样式约定

- 沿用现有 `popup.css` 风格（`body { width: 360px; ... }` 不变）。
- Tab 栏：`display: flex; gap: 0; border-bottom: 1px solid #eee; margin-bottom: 8px;`。
- Tab 按钮：`flex: 1; background: none; border: none; padding: 6px 0; cursor: pointer; font-size: 12px; color: #888; border-bottom: 2px solid transparent;`。
- Tab 按钮 active：`color: #222; border-bottom-color: #15803d;`（绿色与 `.ok` 一致）。
- Panel：默认 `display: block`；非 active `display: none`。
- 现有 `.card` 样式复用，不改。
- 现有 `.demo-panel` / `#demo-mount` 样式保留（本次不用，未来若再内嵌可直接复用）。

## 5. demo 源迁移

### 5.1 迁移路径

```
examples/demo-page/index.html  →  src/demo/demo-page/index.html
examples/demo-page/demo.js     →  src/demo/demo-page/demo.js
examples/demo-page/            →  删除整个目录
```

**内容字节级不变**，只搬路径。

### 5.2 build.mjs 改动

旧：

```js
await cp('examples/demo-page/index.html', 'extension/demo/index.html');
await cp('examples/demo-page/demo.js', 'extension/demo/demo.js');
// ...
await cp('examples/demo-page/demo.js', scriptPath);
```

新：

```js
await cp('src/demo/demo-page/index.html', 'extension/demo/index.html');
await cp('src/demo/demo-page/demo.js', 'extension/demo/demo.js');
// ...
await cp('src/demo/demo-page/demo.js', scriptPath);
```

`node --check` 验证段保留（v0.1.46 引入，防 TS 语法泄漏到浏览器报 SyntaxError 的回归）。

### 5.3 manifest.json

**不变**。`web_accessible_resources` 仍声明 `"demo/index.html"`（相对扩展根），Open Demo 按钮仍调 `chrome.runtime.getURL('demo/index.html')`。

### 5.4 README

目录约定更新：

旧：

```
- `examples/demo-page/` —— popup 里"Open Demo in new window"弹窗用的 demo HTML+JS
```

新：

```
- `src/demo/demo-page/` —— popup 里"Open Demo in new tab"弹窗用的 demo HTML+JS（迁移自原 examples/demo-page/）
```

## 6. 不改的东西（明确边界）

- `src/popup/snippet.ts`：formatAuthState 不变。
- `src/demo/demo-runner.ts`：本次不内嵌，文件不变；jsdom 单测不变。
- `src/background/sw.ts`：panel.* handler 全保留。
- `extension/manifest.json`：web_accessible_resources 路径不变。
- `tests/unit/popup-helpers.test.ts`：只测 formatAuthState，不破坏。
- `tests/unit/demo-runner.test.ts`：不依赖 popup 结构，不破坏。
- `tests/integration/router.test.ts`：panel.* 协议不变，不破坏。

## 7. 实施步骤（概要）

实际任务清单由 writing-plans skill 拆分，此处只列高层顺序：

1. worktree `feat/popup-tabs`。
2. 写 popup Tab 结构（html + css + ts）。
3. 迁移 demo 源到 `src/demo/demo-page/`。
4. 改 build.mjs。
5. 跑 `npm test` 全绿。
6. `npm run build` 确认 extension/ 产物正确。
7. 删 examples/demo-page/。
8. 更新 README + memory。
9. `npm run bump`（v0.1.60 → v0.1.61）。
10. 合并回 main。

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改 Tab 后现有 popup-helpers 测试失败 | 低 | 测试只覆盖 formatAuthState，未碰触；改前跑一次确认 |
| build.mjs 路径改错导致 extension/demo/ 没产物 | 中 | `npm run build` 后 `ls extension/demo/` 验证两个文件都在 |
| 删 examples/demo-page/ 误伤 | 中 | git rm + 改 build.mjs 同步进行；删除前确保 build.mjs 已改 |
| Tab 切换 bug 导致 Panel 错乱 | 低 | 人工冒烟测试三 Tab 都能打开且内容正确 |

回滚策略：worktree 内所有改动可一次性丢弃，main 分支不受影响。

## 9. 验收标准

- [ ] popup.html 含 `<nav class="tab-bar">` + 三个 `.tab-btn` + 三个 `.tab-panel`。
- [ ] popup 默认打开显示「主页」Tab，「设置」「日志」不可见。
- [ ] 点击每个 Tab 按钮切换到对应 Panel，状态切换正确。
- [ ] 「主页」Tab 含 snippet（textarea + 复制按钮）、模型列表、Open Demo 按钮。
- [ ] 「设置」Tab 含登录状态（auth-state + 刷新/同步按钮 + 打开登录页）、配置（pool/ttl）。
- [ ] 「日志」Tab 含复制按钮 + 说明 + 日志列表。
- [ ] Open Demo 按钮行为不变：点击开新 tab 加载 `chrome-extension://.../demo/index.html`。
- [ ] `src/demo/demo-page/index.html` 与 `src/demo/demo-page/demo.js` 内容与原 examples/demo-page/ 字节级一致。
- [ ] `examples/demo-page/` 目录已删除。
- [ ] build.mjs 改用 `src/demo/demo-page/` 作为 demo 拷贝源。
- [ ] `npm test` 全绿。
- [ ] `npm run build` 产物含 `extension/demo/index.html` + `extension/demo/demo.js`。
- [ ] `extension/manifest.json` 未改。
- [ ] README + memory 文档同步更新。
