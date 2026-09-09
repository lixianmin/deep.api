# popup Tabs v2 + SW port bug 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** popup 主页 Tab 加登录卡 + 重排内容顺序；Tab 顺序调整为 主页/日志/设置；三 Tab 高度同步；修 SW panel port disconnected bug。

**Architecture:** popup.html 重排 4 个卡的位置（13 个 id 全保留）；popup.ts 加 `syncTabHeight()`（render 末尾调用）；sw.ts 的 `deepapi-panel` 分支加 `panelAlive` + `safePostPanel`（对齐 deepapi safePost 范式）；memory 加 1 条教训。

**Tech Stack:** TypeScript / esbuild / Chrome MV3 / vitest + jsdom

**Spec:** `docs/superpowers/specs/2026-09-09-popup-tabs-v2-design.md`

## Global Constraints

- **worktree 隔离**：所有改动仅在 `.worktrees/popup-tabs-v2` 内。
- **MV3 CSP**：popup.html 不允许 inline `<script>`（沿用 v0.1.61）。
- **build 产物**：`extension/`（gitignored）。
- **测试**：vitest。`npm test` 必须 0 fail。
- **commit 频率**：每个 task 一次独立 commit，主题 ≤72 字。
- **demo 字节级不变**：本任务不碰 demo。
- **历史文档不动**：`docs/superpowers/{plans,specs}/2026-09-08-*` 保留 examples/demo-page 历史引用。
- **agent 选型**：所有 implementation task 用 `delegate`（fresh context，工具齐全）。reviewer 继续用 `reviewer`。
- **版本**：本次改动后 `npm run bump`（v0.1.61 → v0.1.62）。

---

## File Structure

**修改：**
- `src/popup/popup.html` — 4 个 panel 内容重排 + Tab 顺序调整为 home/logs/settings
- `src/popup/popup.css` — `.tab-panel` 加 `overflow: hidden` 一行
- `src/popup/popup.ts` — 新增 `syncTabHeight()`；render 末尾调用
- `src/background/sw.ts` — `deepapi-panel` 分支加 panelAlive + safePostPanel
- `docs/01.memory.md` — 文件索引区下方"经验教训"加 1 条

**新增：** 无
**删除：** 无

---

## Task 1: popup.html Tab 内容重排 + Tab 顺序调整

**Files:**
- Modify: `src/popup/popup.html`

**Interfaces:**
- Consumes: v0.1.61 popup.html（已存在的 6 个 .card）
- Produces: 4 个 panel，顺序 home / logs / settings；13 个 id 全部存在；第一个 panel/btn 默认 active

- [ ] **Step 1: 读当前 popup.html**

```bash
cd /Users/xmli/me/code/deep.api/.worktrees/popup-tabs-v2
cat src/popup/popup.html
```

确认当前 6 个 .card 在 3 个 panel 内的位置（v0.1.61 已落地）。

- [ ] **Step 2: write 整体重写 popup.html**

完整内容：

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
    <button class="tab-btn" data-tab="logs" role="tab">日志</button>
    <button class="tab-btn" data-tab="settings" role="tab">设置</button>
  </nav>

  <!-- 主页 Panel（默认 active）：登录 + 模型 + snippet + Demo -->
  <section class="tab-panel active" data-tab-panel="home">
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
      <h3>模型</h3>
      <ul id="model-list"></ul>
    </section>

    <section class="card">
      <h3>接入 snippet</h3>
      <textarea id="snippet" rows="6" readonly></textarea>
      <button id="btn-copy-snippet">复制 snippet</button>
    </section>

    <section class="card">
      <h3>Demo</h3>
      <button id="btn-open-demo">↗ Open Demo in new tab</button>
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

  <!-- 设置 Panel：只剩配置（登录卡已搬到主页） -->
  <section class="tab-panel" data-tab-panel="settings">
    <section class="card">
      <h3>配置</h3>
      <label>线程池 <input id="pool-size" type="number" min="1" max="5" value="2"></label>
      <label>TTL 分钟 <input id="ttl-min" type="number" min="1" value="30"></label>
    </section>
  </section>

  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 3: 验证 HTML 结构**

```bash
grep -c 'data-tab="home"\|data-tab="logs"\|data-tab="settings"' src/popup/popup.html  # 预期 3（tab-btn）+ 3（tab-panel）= 6 个 data-tab 出现
grep -c 'data-tab="home"' src/popup/popup.html    # 预期 2（btn + panel 各一）
grep -c 'data-tab="logs"' src/popup/popup.html    # 预期 2
grep -c 'data-tab="settings"' src/popup/popup.html  # 预期 2
grep -c 'class="tab-btn active"\|class="tab-btn"' src/popup/popup.html  # 预期 3
grep -c 'class="tab-panel active"\|class="tab-panel"' src/popup/popup.html  # 预期 3
grep -c 'id="snippet"\|id="btn-copy-snippet"\|id="model-list"\|id="btn-open-demo"\|id="auth-state"\|id="btn-refresh-auth"\|id="btn-repush-auth"\|id="btn-login"\|id="pool-size"\|id="ttl-min"\|id="btn-copy-log"\|id="log-list"\|id="version"' src/popup/popup.html  # 预期 13
```

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.html
git commit -m "feat(popup): Tab 顺序调为 主页/日志/设置 + 主页加登录卡"
```

---

## Task 2: popup.css 加 `.tab-panel { overflow: hidden }`

**Files:**
- Modify: `src/popup/popup.css`

**Interfaces:**
- Consumes: v0.1.61 popup.css（已含 .tab-panel 规则）
- Produces: .tab-panel 默认 `overflow: hidden`

- [ ] **Step 1: 用 edit 改 popup.css 末尾的 `.tab-panel` 规则**

旧（v0.1.61 末尾）：
```
.tab-panel { display: block; }
```

新：
```
.tab-panel { display: block; overflow: hidden; }
```

用 edit 工具：oldText 必须唯一匹配那行。如果有重复匹配失败，可改成更具体的 `display: block; }\n.tab-panel:not(.active)` 等上下文。

- [ ] **Step 2: 验证**

```bash
grep -n "tab-panel" src/popup/popup.css
```

预期看到 `.tab-panel { display: block; overflow: hidden; }` + `.tab-panel:not(.active) { display: none; }`。

- [ ] **Step 3: Commit**

```bash
git add src/popup/popup.css
git commit -m "feat(popup): .tab-panel 加 overflow: hidden 防 min-height 测量误差"
```

---

## Task 3: popup.ts 加 syncTabHeight()

**Files:**
- Modify: `src/popup/popup.ts`

**Interfaces:**
- Consumes: v0.1.61 popup.ts（已有 render() + setupTabs()）
- Produces: 新增 syncTabHeight() 函数（约 20 行），render() 末尾调用一次

- [ ] **Step 1: 读 popup.ts 末尾定位**

```bash
tail -30 src/popup/popup.ts
```

确认 `setupTabs()` 函数定义在哪、`render()` 在哪、`setInterval(refresh, 2000);` 是末尾。

- [ ] **Step 2: 用 edit 在 render() 末尾 + setupTabs 函数后插入 syncTabHeight 定义与调用**

找到 `render()` 函数末尾（最后一行 `});` 是 `logEl.innerHTML = ...` 那行的 close）。在 render 闭合大括号后插入：

```ts
// Tab 高度同步（v0.1.62）：取三 panel 中最高 scrollHeight，设所有 panel min-height。
// 隐藏 panel 测量时临时移出屏幕外（visibility:hidden + position:absolute + left:-9999px），保持视觉无闪烁。
syncTabHeight();
function syncTabHeight(): void {
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  let max = 0;
  panels.forEach(p => {
    const wasActive = p.classList.contains('active');
    if (!wasActive) {
      p.style.visibility = 'hidden';
      p.style.display = 'block';
      p.style.position = 'absolute';
      p.style.left = '-9999px';
    }
    const h = p.scrollHeight;
    if (h > max) max = h;
    if (!wasActive) {
      p.style.visibility = '';
      p.style.display = '';
      p.style.position = '';
      p.style.left = '';
    }
  });
  panels.forEach(p => { p.style.minHeight = max + 'px'; });
}
```

**注意**：TS 函数声明 hoist，调用在前合法。

- [ ] **Step 3: 验证 TS 编译**

```bash
npx esbuild src/popup/popup.ts --bundle --minify --target=es2022 --format=iife > /tmp/popup-build-test.js 2>&1 && echo OK
```

预期：`OK`。

- [ ] **Step 4: Commit**

```bash
git add src/popup/popup.ts
git commit -m "feat(popup): syncTabHeight() 三 Tab 高度同步"
```

---

## Task 4: sw.ts panel port safePostPanel

**Files:**
- Modify: `src/background/sw.ts`

**Interfaces:**
- Consumes: v0.1.61 sw.ts（已有 deepapi safePost + panel 裸 postMessage）
- Produces: panel 分支加 panelAlive + safePostPanel；3 处裸 postMessage 改 safePostPanel

- [ ] **Step 1: 读 sw.ts panel 分支**

```bash
grep -n "deepapi-panel\|panelPorts" src/background/sw.ts
```

定位 panel 分支（`} else if (port.name === 'deepapi-panel') {`）。

- [ ] **Step 2: 用 edit 替换整个 panel 分支的 onConnect 内代码块**

oldText：当前 panel 分支（从 `} else if (port.name === 'deepapi-panel') {` 开始到下一个 `});` 结束）。

newText：

```ts
  } else if (port.name === 'deepapi-panel') {
    // port 存活追踪：reload 扩展 / popup 关闭 / SW 重启时 port 被 Chrome 关闭，
    // 后续 postMessage 会抛 "Attempting to use a disconnected port object"。
    // 所有发送走 safePostPanel（与 deepapi 分支 safePost 同范式）。
    let panelAlive = true;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      panelAlive = false;
      panelPorts.delete(port);
    });
    const safePostPanel = (m: unknown): void => {
      if (!panelAlive) return;
      try {
        port.postMessage(m as any);
      } catch {
        panelAlive = false;
      }
    };
    port.onMessage.addListener(async (msg: any) => {
      const { router, log } = await build();
      if (msg?.kind === 'panel.getState') {
        const provCfg = await getProviderConfig('deepseek');
        const logList = (await STORAGE.get('log')) as unknown as { log?: any[] };
        safePostPanel({
          kind: 'state',
          payload: {
            providers: {
              deepseek: { ...provCfg, models: router.models ? (await router.models()).data : [] },
            },
            log: (logList?.log as any[]) ?? log.list(),
          },
        });
      } else if (msg?.kind === 'panel.openLogin') {
        await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
      } else if (msg?.kind === 'panel.refreshAuth') {
        await refreshAuthAndLog();
        await broadcastPanelState();
      } else if (msg?.kind === 'panel.repushAuth') {
        // 强制对所有 chat.deepseek.com 标签页重新注入 content script（不需要用户手动 F5）
        try {
          const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
          console.log('[deep.api sw] repushAuth: found', tabs.length, 'chat.deepseek.com tab(s)');
          for (const t of tabs) {
            if (t.id !== undefined) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: t.id, allFrames: true },
                  files: ['bridge-main.js'],
                });
                console.log('[deep.api sw] repushAuth: re-injected into tab', t.id, t.url);
              } catch (e) { console.warn('[deep.api sw] repushAuth: failed for tab', t.id, e); }
            }
          }
        } catch (e) { console.warn('[deep.api sw] repushAuth error', e); }
      } else if (msg?.kind === 'panel.setPool') {
        await setProviderConfig('deepseek', { poolSize: msg.payload.poolSize });
      } else if (msg?.kind === 'panel.setTtl') {
        await setProviderConfig('deepseek', { ttlMinutes: msg.payload.ttlMinutes });
      } else if (msg?.kind === 'panel.listLogs') {
        safePostPanel({ kind: 'state', payload: { log: log.list() } });
      } else if (msg?.kind === 'ping') {
        safePostPanel({ kind: 'pong' });
      }
    });
  }
```

- [ ] **Step 3: 验证 sw.ts 编译 + 无残留裸 postMessage**

```bash
npx esbuild src/background/sw.ts --bundle --minify --target=es2022 --format=esm > /tmp/sw-build-test.js 2>&1 && echo OK
grep -n "port.postMessage\|n.postMessage" src/background/sw.ts
```

预期：
- esbuild `OK`
- grep 输出应只看到：
  - L199 `try { p.postMessage(...) } catch { /* port closed mid-broadcast */ }`（已在 try/catch）
  - L216 `port.postMessage(m as unknown as unknown);`（在 safePost 函数体内）
  - L292 `port.postMessage({...})` —— **应该是 safePostPanel**（如果还有这一行就是漏改）

**所有 `port.postMessage` 必须满足以下条件之一**：
- 在 `try { ... } catch { ... }` 内
- 通过 `safePost(...)` 或 `safePostPanel(...)` 函数调用

- [ ] **Step 4: Commit**

```bash
git add src/background/sw.ts
git commit -m "fix(sw): panel port 加 panelAlive + safePostPanel 防 reload 报 disconnected port"
```

---

## Task 5: memory 加 1 条经验教训

**Files:**
- Modify: `docs/01.memory.md`

**Interfaces:**
- Consumes: v0.1.61 memory
- Produces: "经验教训" 区新增 1 条

- [ ] **Step 1: 读 memory 找经验教训区**

```bash
grep -n "经验教训" docs/01.memory.md
```

定位经验教训节标题（应在文件中部某位置）。

- [ ] **Step 2: 用 edit 在经验教训区最末（或合适位置）追加新条目**

读出该节末尾的格式（应类似 `- **X**：结论 + 修法 + 关键数字`）。在末尾追加：

```
- **SW port disconnected console error**（v0.1.62 修复）：`chrome.runtime.onConnect` 任意分支只要调 `port.postMessage`，必须套 `safePost`（portAlive + try/catch）。v0.1.61 `deepapi` 分支做了、`deepapi-panel` 分支漏掉，导致 reload 扩展时 console 报 unhandled `Attempting to use a disconnected port object`。修法：在 onConnect 内 `let panelAlive = true; port.onDisconnect.addListener(() => { panelAlive = false; panelPorts.delete(port); }); const safePostPanel = (m) => { if (!panelAlive) return; try { port.postMessage(m); } catch { panelAlive = false; } };` 3 处裸 postMessage 改 safePostPanel。
```

格式以 memory 现有条目为准（参考 memory 里其它以 `- **bold 关键词**` 开头的条目格式）。

- [ ] **Step 3: 验证**

```bash
grep -c "panelAlive\|safePostPanel" docs/01.memory.md
```

预期 ≥ 1。

- [ ] **Step 4: Commit**

```bash
git add docs/01.memory.md
git commit -m "docs(memory): SW port disconnected console error 教训（v0.1.62 修）"
```

---

## Task 6: 全量验证 + bump + merge + push + 清理

**Files:** 无（合并 + 发版步骤）

**Interfaces:**
- Consumes: Task 1-5 全部完成
- Produces: 工作分支合并到 main + bump v0.1.62 + push + worktree 清理

- [ ] **Step 1: 全量测试 + build**

```bash
cd /Users/xmli/me/code/deep.api/.worktrees/popup-tabs-v2
npm test 2>&1 | tail -10  # 预期 19 files / 117 tests passed
npm run build 2>&1 | tail -10  # 预期 build + copy done + demo.js node --check: OK
```

- [ ] **Step 2: 回到主目录 merge**

```bash
cd /Users/xmli/me/code/deep.api
git fetch . .worktrees/popup-tabs-v2:feat/popup-tabs-v2
git merge --ff-only feat/popup-tabs-v2
git log --oneline -10
```

预期：merge 是 fast-forward（worktree 从 main 的 7e378f7 拉出，commit 都在前面）。

- [ ] **Step 3: bump 版本**

```bash
npm run bump
grep '"version"' package.json extension/manifest.json manifest.json  # 全部应为 0.1.62
```

- [ ] **Step 4: rebuild + push**

```bash
npm run build
git add manifest.json package.json
git commit -m "chore: bump v0.1.61 → v0.1.62（popup Tab v2 + SW port bug 修复）"
git push origin main
```

- [ ] **Step 5: 清理 worktree + 分支 + SDD workspace**

```bash
git worktree remove .worktrees/popup-tabs-v2
git branch -d feat/popup-tabs-v2
rm -rf .superpowers/sdd/2026-09-09-popup-tabs-v2
```

- [ ] **Step 6: 视觉冒烟（人工）**

按 AGENTS.md §5 + spec §9：
1. Chrome → `chrome://extensions` → 移除旧版 → 加载 `extension/` 目录
2. 点 deep.api icon：
   - 主页 Tab 顶部显示登录卡（含 3 按钮 + 打开登录页）
   - 主页 Tab 中间显示模型
   - 主页 Tab 再下显示 snippet + 复制
   - 主页 Tab 最下显示 Demo 按钮
   - 三 Tab 高度一致
   - Tab 顺序：主页 / 日志 / 设置
   - 设置 Tab 只剩配置（pool/ttl）
3. Open Service Worker 链接 → 看 console 应**无** "Attempting to use a disconnected port object" 报错

---

## Self-Review

**Spec 覆盖：**

| spec § | 内容 | 覆盖 task |
|---|---|---|
| §4.1 Tab 顺序 home/logs/settings | Task 1 | ✓ |
| §4.2 主页 panel 4 卡顺序 | Task 1 | ✓ |
| §4.3 日志 panel 不变 | Task 1 保留 | ✓ |
| §4.4 设置 panel 只剩配置 | Task 1 | ✓ |
| §4.5 13 个 id 保留 | Task 1 Step 3 验证 | ✓ |
| §5.1 syncTabHeight 实现 | Task 3 | ✓ |
| §5.2 调用时机（render 末尾） | Task 3 | ✓ |
| §5.3 性能 | Task 3 Step 3 编译通过即性能 OK | ✓ |
| §5.4 CSS 配合 overflow:hidden | Task 2 | ✓ |
| §6.2 SW safePostPanel 修复 | Task 4 | ✓ |
| §6.3 broadcastPanelState 不动 | Task 4 保留 | ✓ |
| §6.4 deepapi 分支不动 | Task 4 保留 | ✓ |
| memory 加经验教训 | Task 5 | ✓ |
| §9 验收 | Task 1-6 涵盖 | ✓ |

**Placeholder 扫描：** 无 TBD/TODO/类似。

**类型一致性：**
- `syncTabHeight(): void` 定义 + 调用 ✓
- `safePostPanel(m: unknown): void` 调用 3 处（panel.getState / panel.listLogs / panel.ping）✓
- `panelAlive` 类型推断 boolean ✓

**风险点：**
- Task 4 edit 的 oldText 比较大（整段 panel 分支）。如果匹配多行不一致，subagent 应改用"按行替换 + 重读校验"策略。
- Task 6 Step 6 视觉冒烟是人工步骤，spec §9 硬要求。

Plan 完成。
