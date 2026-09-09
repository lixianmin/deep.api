# Popup Tabs + demo 源迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 popup 重构为 3 个 Tab（主页 / 设置 / 日志），同时把 `examples/demo-page/` 迁到 `src/demo/demo-page/`，并删掉 examples 目录。

**Architecture:** popup.html 顶部加 `<nav class="tab-bar">` + 3 个 `<section class="tab-panel">`，HTML 预置第一个 panel `class="active"`，CSS 用 `.tab-panel:not(.active) display: none` 切显隐，JS 一个 ~10 行 `setupTabs()` 监听 click。demo 源纯路径迁移（`git mv`），内容字节级不变；build.mjs 改 3 行拷贝源 + demo-shim test 改 1 行 import。

**Tech Stack:** TypeScript / esbuild / Chrome MV3 / vitest + jsdom

**Spec:** `docs/superpowers/specs/2026-09-09-popup-tabs-design.md`

## Global Constraints

- **MV3 CSP**：popup.html 不允许 inline `<script>`；所有 JS 走 `<script src="popup.js">`。（沿用现状）
- **worktree 隔离**：所有代码变更在 `feat/popup-tabs` worktree 内进行；main 目录在合并前不修改（AGENTS.md §13）。
- **commit 频率**：每个 task 结束一次独立 commit；commit message 中文主题 ≤72 字。
- **build 产物**：`extension/`（gitignored）。`npm run build` 须产出 `extension/demo/index.html` + `extension/demo/demo.js`。
- **测试**：vitest。`npm test` 必须全绿。
- **demo 内容字节级不变**：迁移只搬路径，不改 index.html / demo.js 任何字符。
- **版本**：本次改动后 `npm run bump`（v0.1.60 → v0.1.61）。
- **历史文档不动**：`docs/superpowers/plans/2026-09-08-deep-api-extension.md` 与 `docs/superpowers/specs/2026-09-08-deep-api-extension-design.md` 保留对 `examples/demo-page/` 的历史引用（已落盘归档）。

---

## File Structure

**新增：**
- `src/demo/demo-page/index.html` —— 从 `examples/demo-page/index.html` 迁移，字节级不变
- `src/demo/demo-page/demo.js` —— 从 `examples/demo-page/demo.js` 迁移，字节级不变

**修改：**
- `src/popup/popup.html` —— 拆 Tab 结构（3 个 panel + tab-bar nav）
- `src/popup/popup.css` —— 加 `.tab-bar` / `.tab-btn` / `.tab-btn.active` / `.tab-panel` 样式
- `src/popup/popup.ts` —— 加 `setupTabs()` 函数（约 10 行），在 body 末尾脚本最末调用一次
- `build.mjs` —— 改 3 行：`examples/demo-page/` → `src/demo/demo-page/`
- `tests/unit/demo-shim.test.ts:23` —— 改 1 行 import 路径
- `src/demo/demo-runner.ts:2` —— 改注释中 1 处路径引用
- `README.md` —— 改 1 行目录约定
- `docs/01.memory.md` —— 文件索引区加 1 条

**删除：**
- `examples/demo-page/` 整个目录
- （`examples/` 目录变空后再删 — 见 Task 7）

---

## Task 1: 准备 worktree 并迁移 demo 源（git mv，字节级不变）

**Files:**
- Move: `examples/demo-page/index.html` → `src/demo/demo-page/index.html`
- Move: `examples/demo-page/demo.js` → `src/demo/demo-page/demo.js`
- Test: `tests/unit/demo-shim.test.ts`（路径仍指向旧位置，本任务不动，Task 4 改）

**Interfaces:**
- Consumes: 无
- Produces: `src/demo/demo-page/{index.html,demo.js}` 两个文件存在且与原 examples 内容字节级一致

- [ ] **Step 1: 创建 worktree**

```bash
cd /Users/xmli/me/code/deep.api
git fetch origin
git worktree add -b feat/popup-tabs .worktrees/popup-tabs origin/main
cd .worktrees/popup-tabs
```

验证：`git status` 输出 `On branch feat/popup-tabs`，无未提交改动。

- [ ] **Step 2: git mv 迁移 demo 源**

```bash
mkdir -p src/demo/demo-page
git mv examples/demo-page/index.html src/demo/demo-page/index.html
git mv examples/demo-page/demo.js src/demo/demo-page/demo.js
```

验证：
- `git status` 看到两个 rename（git 自动识别为改名，文件模式 100644）
- `ls examples/demo-page/` 输出空（两个文件已移走）
- `ls src/demo/demo-page/` 含 `index.html` 和 `demo.js`

- [ ] **Step 3: 验证字节级一致**

```bash
diff -q src/demo/demo-page/index.html <(git show HEAD:examples/demo-page/index.html)
diff -q src/demo/demo-page/demo.js <(git show HEAD:examples/demo-page/demo.js)
```

两条命令都应无输出（一致）。如有任何 diff 输出，**停止**并报 — 这意味着 git rename 误判或文件被改，本次任务失败。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: demo 源迁移 examples/demo-page → src/demo/demo-page (v0.1.61)"
```

验证：`git log --oneline -1` 输出新 commit。

---

## Task 2: 改 build.mjs 拷贝源 + demo 语法验证源

**Files:**
- Modify: `build.mjs`（3 处：拷贝 index.html、拷贝 demo.js、demo.js 验证的临时源）

**Interfaces:**
- Consumes: Task 1 迁好的 `src/demo/demo-page/*`
- Produces: `npm run build` 产出 `extension/demo/index.html` + `extension/demo/demo.js`

- [ ] **Step 1: 读 build.mjs 当前内容**

```bash
cat build.mjs
```

找到三处 `examples/demo-page/`。**确切文本**：
- 行 25: `await cp('examples/demo-page/index.html', 'extension/demo/index.html');`
- 行 26: `await cp('examples/demo-page/demo.js', 'extension/demo/demo.js');`
- 行 32: `await cp('examples/demo-page/demo.js', scriptPath);`

- [ ] **Step 2: 用 edit 一次性替换三处**

```bash
# 用 edit 工具更稳：
# oldText: "examples/demo-page/"
# newText: "src/demo/demo-page/"
```

具体用 edit 工具，三处都用同一个 oldText / newText（edit 工具会按行号分别匹配，全部命中）。**注意**：edit 的 oldText 必须在文件中唯一。如果 edit 报错说"not unique"，说明前后行相同导致多个匹配——这种情况需分别替换（带更多上下文）。

- [ ] **Step 3: 验证 build.mjs 修改正确**

```bash
grep -n "demo-page" build.mjs
```

预期：3 行全部显示 `src/demo/demo-page/`，无 `examples/demo-page/` 残留。

- [ ] **Step 4: 跑 build 验证产物**

```bash
rm -rf extension/demo
npm run build
ls -la extension/demo/
```

预期：列出 `index.html` 和 `demo.js`，文件大小与 examples 原文件一致。控制台看到 `build + copy done` + `demo.js node --check: OK`。

- [ ] **Step 5: 验证字节级一致**

```bash
diff -q extension/demo/index.html src/demo/demo-page/index.html
diff -q extension/demo/demo.js src/demo/demo-page/demo.js
```

两条命令无输出。

- [ ] **Step 6: Commit**

```bash
git add build.mjs
git commit -m "build: demo 拷贝源改 src/demo/demo-page/"
```

---

## Task 3: 改 popup.html 为 Tab 结构

**Files:**
- Modify: `src/popup/popup.html`

**Interfaces:**
- Consumes: 现有 popup.html（6 个 `.card` 平铺）
- Produces: Tab 结构 HTML — `<nav class="tab-bar">` 含 3 个 `.tab-btn`，3 个 `<section class="tab-panel">`，第一个 panel 默认 `class="tab-panel active"`，第一个 tab 默认 `class="tab-btn active"`

- [ ] **Step 1: 读当前 popup.html**

```bash
cat src/popup/popup.html
```

确认当前结构（6 个 `.card`：auth、snippet、模型、配置、日志、Demo 按钮）。

- [ ] **Step 2: 用 write 整体重写 popup.html**

将 popup.html 替换为以下内容：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="popup.css">
</head>
<body>
  <header><b>deep.api</b> <span id="version" class="small"></span></header>

  <nav class="tab-bar" role="tablist">
    <button class="tab-btn active" data-tab="home" role="tab">主页</button>
    <button class="tab-btn" data-tab="settings" role="tab">设置</button>
    <button class="tab-btn" data-tab="logs" role="tab">日志</button>
  </nav>

  <!-- 主页 Panel（默认 active）：snippet + 模型 + Open Demo 按钮 -->
  <section class="tab-panel active" data-tab-panel="home">
    <section class="card">
      <h3>接入 snippet</h3>
      <textarea id="snippet" rows="6" readonly></textarea>
      <button id="btn-copy-snippet">复制 snippet</button>
    </section>

    <section class="card">
      <h3>模型</h3>
      <ul id="model-list"></ul>
    </section>

    <section class="card">
      <h3>Demo</h3>
      <button id="btn-open-demo">↗ Open Demo in new tab</button>
    </section>
  </section>

  <!-- 设置 Panel：登录状态 + 线程池/TTL -->
  <section class="tab-panel" data-tab-panel="settings">
    <section class="card">
      <div class="row">
        <h3 style="flex:1;margin:0;font-size:12px;color:#666;font-weight:600">登录状态</h3>
        <button id="btn-refresh-auth" title="重新探测">↻</button>
        <button id="btn-repush-auth" title="强制重新注入 content script 并同步 token">🔄 立即同步</button>
      </div>
      <div id="auth-state" class="bad">未登录</div>
      <button id="btn-login" style="margin-top:6px">打开登录页</button>
    </section>

    <section class="card">
      <h3>配置</h3>
      <label>线程池 <input id="pool-size" type="number" min="1" max="5" value="2"></label>
      <label>TTL 分钟 <input id="ttl-min" type="number" min="1" value="30"></label>
    </section>
  </section>

  <!-- 日志 Panel -->
  <section class="tab-panel" data-tab-panel="logs">
    <section class="card">
      <div class="row">
        <h3 style="flex:1;margin:0;font-size:12px;color:#666;font-weight:600">日志</h3>
        <button id="btn-copy-log" title="复制最近 200 条日志为 JSON（排查用）">复制</button>
      </div>
      <p class="small">每条 chat.completions.create 的路由决策现场：rebuild 旧 web session 被删、incremental 复用、threadFound / mirror 是否匹配。复制后贴给 AI / 自己看。</p>
      <ul id="log-list"></ul>
    </section>
  </section>

  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 3: 验证 HTML 结构**

```bash
grep -c "tab-panel" src/popup/popup.html  # 预期 3（3 个 panel）
grep -c "tab-btn" src/popup/popup.html     # 预期 3（3 个 button）
grep -c 'class="tab-btn active"\|class="tab-btn"' src/popup/popup.html  # 预期 3
grep -c 'class="tab-panel active"\|class="tab-panel"' src/popup/popup.html  # 预期 3
grep -c "id=\"snippet\"\|id=\"btn-copy-snippet\"\|id=\"model-list\"\|id=\"btn-open-demo\"\|id=\"auth-state\"\|id=\"btn-refresh-auth\"\|id=\"btn-repush-auth\"\|id=\"btn-login\"\|id=\"pool-size\"\|id=\"ttl-min\"\|id=\"btn-copy-log\"\|id=\"log-list\"\|id=\"version\"" src/popup/popup.html  # 预期 13
```

所有数字符合预期后继续。

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html
git commit -m "feat(popup): 拆 Tab 结构（主页/设置/日志）"
```

---

## Task 4: 改 popup.css 加 Tab 样式

**Files:**
- Modify: `src/popup/popup.css`（追加，不覆盖现有规则）

**Interfaces:**
- Consumes: Task 3 的 HTML 结构（`.tab-bar` / `.tab-btn` / `.tab-btn.active` / `.tab-panel` / `.tab-panel.active`）
- Produces: 顶部水平 Tab 栏，active Tab 绿色下划线

- [ ] **Step 1: 在 popup.css 末尾追加 Tab 样式**

在 `src/popup/popup.css` 文件末尾追加：

```css
/* Tab 栏（v0.1.61 popup 重构） */
.tab-bar { display: flex; gap: 0; border-bottom: 1px solid #eee; margin-bottom: 8px; }
.tab-btn {
  flex: 1;
  background: none;
  border: none;
  padding: 6px 0;
  cursor: pointer;
  font-size: 12px;
  color: #888;
  border-bottom: 2px solid transparent;
  font-family: inherit;
}
.tab-btn:hover { color: #222; }
.tab-btn.active { color: #222; border-bottom-color: #15803d; }
.tab-panel { display: block; }
.tab-panel:not(.active) { display: none; }
```

- [ ] **Step 2: 验证 CSS 追加正确**

```bash
grep -c "tab-bar\|tab-btn\|tab-panel" src/popup/popup.css
```

预期 ≥ 6（4 行规则 + 1 个 `.tab-panel:not(.active)` + 至少 1 个 `.tab-panel { display: block; }`）。

- [ ] **Step 3: Commit**

```bash
git add src/popup/popup.css
git commit -m "feat(popup): Tab 栏样式"
```

---

## Task 5: 改 popup.ts 加 setupTabs()

**Files:**
- Modify: `src/popup/popup.ts`

**Interfaces:**
- Consumes: Task 3 的 HTML（`.tab-btn[data-tab]` / `.tab-panel[data-tab-panel]`）
- Produces: 点击 Tab 切换 active class 与 panel 显隐

- [ ] **Step 1: 找到 popup.ts 末尾**

```bash
tail -20 src/popup/popup.ts
```

当前末尾是 `setInterval(refresh, 2000);`。

- [ ] **Step 2: 用 edit 替换 setInterval 那一行，在它前面加 setupTabs() 调用**

在 `setInterval(refresh, 2000);` **前一行**插入：

```ts
// Tab 切换（v0.1.61 popup 重构）：监听 .tab-btn click，切换 .active class。
// HTML 已预置第一个 panel/btn 为 active，无需默认 click()。
setupTabs();
function setupTabs(): void {
  const btns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  for (const btn of btns) {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      for (const b of btns) b.classList.toggle('active', b === btn);
      for (const p of panels) p.classList.toggle('active', p.dataset.tabPanel === target);
    });
  }
}
```

**注意**：因 TS 函数声明会 hoist，`setupTabs()` 在声明前调用合法，无需把函数放在调用前。

- [ ] **Step 3: 验证 TS 编译**

```bash
npx esbuild src/popup/popup.ts --bundle --minify --target=es2022 --format=iife > /tmp/popup-build-test.js 2>&1 && echo OK
```

预期：`OK`。如有任何 TS 错误，**停止**并按报错修复（很可能是类型注解问题）。

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.ts
git commit -m "feat(popup): setupTabs() 切换 3 个 panel"
```

---

## Task 6: 改 demo-shim.test.ts import 路径 + demo-runner.ts 注释

**Files:**
- Modify: `tests/unit/demo-shim.test.ts:23`
- Modify: `src/demo/demo-runner.ts:2`

**Interfaces:**
- Consumes: Task 1 迁好的 `src/demo/demo-page/demo.js`
- Produces: 测试 import 路径正确指向新位置；demo-runner 注释里的路径引用更新

- [ ] **Step 1: 改 demo-shim.test.ts**

读当前内容（确认行 23 文本）：

```bash
sed -n '20,25p' tests/unit/demo-shim.test.ts
```

用 edit 替换：

- oldText: `return import(/* @ts-ignore */ '../../examples/demo-page/demo.js' as any).catch(() => undefined);`
- newText: `return import(/* @ts-ignore */ '../../src/demo/demo-page/demo.js' as any).catch(() => undefined);`

- [ ] **Step 2: 改 demo-runner.ts 注释**

```bash
sed -n '1,3p' src/demo/demo-runner.ts
```

当前是：`* 共享 demo runner — 供 demo-page (examples/demo-page/index.html) 和 popup "Open Demo" 折叠面板使用。`

用 edit 替换：

- oldText: `* 共享 demo runner — 供 demo-page (examples/demo-page/index.html) 和 popup "Open Demo" 折叠面板使用。`
- newText: `* 共享 demo runner — 供 demo-page (src/demo/demo-page/index.html) 和 popup "Open Demo" 折叠面板使用。`

- [ ] **Step 3: 跑 demo-shim 单测验证**

```bash
npx vitest run tests/unit/demo-shim.test.ts 2>&1 | tail -30
```

预期：`1 passed`（或类似 PASS 行）。如失败，停止报 — 大概率是 import 路径 typo。

- [ ] **Step 4: 跑全量测试**

```bash
npm test 2>&1 | tail -30
```

预期：所有测试通过，原有 97/93 等数字与基线一致（具体数字以 baseline 为准，**核心：0 fail**）。

- [ ] **Step 5: Commit**

```bash
git add tests/unit/demo-shim.test.ts src/demo/demo-runner.ts
git commit -m "test+docs: demo-shim import 路径改 src/demo/demo-page + demo-runner 注释路径同步"
```

---

## Task 7: 删除 examples/demo-page/ + examples 空目录 + 更新 README + memory

**Files:**
- Delete: `examples/demo-page/`（已在 Task 1 移走，应已空；显式 `git rm` 防残留）
- Delete: `examples/`（如空目录）
- Modify: `README.md:36`
- Modify: `docs/01.memory.md`（文件索引区）

**Interfaces:**
- Consumes: Task 1 完成
- Produces: examples 目录完全消失；文档同步

- [ ] **Step 1: 删除 examples 目录（空目录）**

```bash
ls examples/
# 预期：空（仅 . 和 ..）
rmdir examples/
git status
```

如果 `examples/` 还有文件（除了 `demo-page/` 之外），**停止**报。理论上 examples/ 只有 demo-page/，Task 1 已移走。

- [ ] **Step 2: 更新 README.md**

读当前内容：

```bash
sed -n '30,40p' README.md
```

第 36 行预期是：`- \`examples/demo-page/\` —— popup 里"Open Demo in new window"弹窗用的 demo HTML+JS`

用 edit 替换：

- oldText: `- \`examples/demo-page/\` —— popup 里"Open Demo in new window"弹窗用的 demo HTML+JS`
- newText: `- \`src/demo/demo-page/\` —— popup 里"Open Demo in new tab"弹窗用的 demo HTML+JS（v0.1.61 起从 examples/demo-page/ 迁入）`

- [ ] **Step 3: 更新 docs/01.memory.md 文件索引**

读当前内容定位文件索引区：

```bash
sed -n '1,20p' docs/01.memory.md
```

在合适位置（如已有 demo 相关条目附近）加一条：

```
- `src/demo/demo-page/` —— popup "Open Demo in new tab" 加载的 demo HTML+JS（v0.1.61 起；前身为 examples/demo-page/，build.mjs 拷到 extension/demo/）。
```

注意：保留既有 `docs/01.memory.md` 中对 `examples/demo-page/` 的历史引用（如有），那是 v0.1.36 教训条目的事实记录，不动；本次新增一条指向新位置即可。

- [ ] **Step 4: 验证无残留 examples 引用（业务代码侧）**

```bash
grep -rln "examples/demo-page" src/ build.mjs tests/ README.md package.json tsconfig.json 2>/dev/null
```

预期：无输出。`docs/` 历史文档不动（见 Global Constraints），业务代码侧清零。

- [ ] **Step 5: 跑全量测试 + build**

```bash
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -10
ls extension/demo/
```

预期：
- 测试全绿
- build 报 `build + copy done` + `demo.js node --check: OK`
- `extension/demo/` 含 `index.html` 和 `demo.js`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: 删 examples/demo-page 残留 + README/memory 同步新路径"
```

---

## Task 8: 手动冒烟（人工验收）

**Files:** 无（人工步骤）

**Interfaces:**
- Consumes: Task 1-7 全部完成
- Produces: 用户在 Chrome 加载 `extension/` 实际看到 3 Tab 切换正确

- [ ] **Step 1: 在主目录构建最新产物**

```bash
cd /Users/xmli/me/code/deep.api  # 注意：回到 main 目录前，先把 worktree commit 推上去
```

**先**把 worktree 推到 main：

```bash
cd /Users/xmli/me/code/deep.api/.worktrees/popup-tabs
git log --oneline origin/main..HEAD  # 列出本次所有 commit
```

应输出 7 条左右 commit（Task 1、2、3、4、5、6、7）。

- [ ] **Step 2: 在主目录 fast-forward 合并**

按 AGENTS.md §13：

```bash
cd /Users/xmli/me/code/deep.api
git fetch . .worktrees/popup-tabs:feat/popup-tabs  # 把 worktree 分支推到本地 ref
git merge --ff-only feat/popup-tabs
npm test 2>&1 | tail -5   # 全量测试再跑一次
```

预期：merge 是 fast-forward；`npm test` 全绿。

- [ ] **Step 3: bump 版本**

```bash
npm run bump
grep version package.json extension/manifest.json manifest.json
```

预期：3 个文件都是 `0.1.61`。

- [ ] **Step 4: 构建产物并加载到 Chrome**

```bash
npm run build
ls extension/popup.html extension/popup.js extension/demo/index.html
```

预期：3 个文件都在。

**人工**：打开 Chrome → `chrome://extensions` → 移除旧版 → "加载已解压的扩展程序" 选 `extension/` 目录 → 点 deep.api 的 icon 看 popup：

1. 默认显示「主页」Tab（snippet textarea + 模型列表 + Open Demo 按钮）
2. 点「设置」Tab → 显示登录状态卡片 + 配置（线程池/TTL）
3. 点「日志」Tab → 显示复制按钮 + 说明 + 日志列表
4. 点 Open Demo 按钮 → 新 tab 打开 `chrome-extension://.../demo/index.html`（页面正常渲染）

任一步异常 → 停止并报。

- [ ] **Step 5: 推送并清理 worktree**

```bash
git push origin main
git worktree remove .worktrees/popup-tabs
git branch -d feat/popup-tabs
```

- [ ] **Step 6: 写最终 commit**

```bash
git add manifest.json package.json extension/manifest.json
git commit -m "chore: bump v0.1.60 → v0.1.61（popup Tabs + demo 源迁移）"
git push origin main
```

---

## Self-Review（写完自查）

**Spec 覆盖：**

| spec § | 内容 | 覆盖 task |
|---|---|---|
| §1 背景与目标 | Tab 重构 + demo 源迁移 | Task 3-7 |
| §4.1 视觉布局 | 顶部水平 Tab 栏 | Task 3 HTML |
| §4.2 Tab 与 Panel 内容映射 | 主页=snippet/模型/Open Demo，设置=登录/配置，日志=日志 | Task 3 |
| §4.3 切换行为 | JS click + classList.toggle + 不持久化 | Task 5 |
| §4.4 HTML 预置 active | 第一个 panel/btn class="active" | Task 3 Step 2 |
| §4.4 JS setupTabs() | 监听 click + 切换 class | Task 5 |
| §4.5 样式 | flex tab-bar + 下划线 active | Task 4 |
| §5.1 迁移路径 | git mv | Task 1 |
| §5.2 build.mjs | 3 处改路径 | Task 2 |
| §5.3 manifest 不变 | 无任务触及 | （验证：Task 2 build 后 `git diff HEAD~ -- extension/manifest.json` 无输出） |
| §5.4 README | 目录约定更新 | Task 7 |
| §5.5 demo-shim test | import 路径改 | Task 6 |
| §6 demo-runner 注释 | 路径引用改 | Task 6 |
| §7 worktree | `feat/popup-tabs` | Task 1 + Task 8 |
| §7 npm test 全绿 | Task 6 + Task 7 | ✓ |
| §7 npm run build | Task 2 + Task 7 | ✓ |
| §7 删 examples/demo-page | Task 7 | ✓ |
| §7 README + memory | Task 7 | ✓ |
| §7 bump 版本 | Task 8 | ✓ |
| §8 风险缓解 | npm run build 后 `ls extension/demo/` | Task 2 + 7 |
| §9 验收 | 跨 Task 1-7 | ✓ |

**Placeholder 扫描：** 无 "TBD" / "TODO" / "implement later" / "similar to Task N"。

**类型一致性：**
- `setupTabs(): void` 在 Task 5 定义 + 调用 — ✓
- `data-tab` / `data-tab-panel` HTML 属性 → JS `dataset.tab` / `dataset.tabPanel` — 一致 ✓
- CSS 类名 `.tab-bar` / `.tab-btn` / `.tab-btn.active` / `.tab-panel` / `.tab-panel.active` — 一致 ✓

**风险点（已知）：**
- popup.html 重写：肉眼对照原 HTML 6 个 card 的内容字段，确保每个 input/button id 都迁移到了正确的 panel。如 Task 3 Step 3 验证 13 个 id 全部存在，OK。
- npm run bump 只动末位：v0.1.60 → v0.1.61，符合预期。
- worktree 路径：`/Users/xmli/me/code/deep.api/.worktrees/popup-tabs`，与现有 `.worktrees/` 一致（v0.1.60 fix/mirror-hash 等 worktree 也是同路径模式）。

Plan 完成。提交。
