# Popup Tab 内容重排 + Tab 高度同步 + SW port bug 修复

日期：2026-09-09 · 状态：待评审 · 版本：v0.1.62 起

## 1. 背景与目标

v0.1.61 popup 拆 Tab 后立刻发现两个问题：

1. **内容布局不合理**：登录卡是"能不能用 deep.api"的首要信号，但塞在"设置"Tab 里；接入 snippet 和模型放主页但顺序与重要性不对应。Tab 顺序"主页/设置/日志"也不合直觉——日志作为排查工具放最后更顺手。
2. **三个 Tab 高度不一致**：log Tab 内容可能很长，切换时 popup 总高突变；其他两个 Tab 短内容撑不满。
3. **SW bug**：reload 扩展时 SW 重启，残留 `panel.postMessage` 调用抛 "Attempting to use a disconnected port object"（实测未捕获，console 红色报错）。`deepapi` 分支已有 `safePost` 模式，panel 分支忘了套。

本次重构目标：

- 主页 Tab 顶部 = 登录卡（最直观的"能不能用"信号）
- 主页 Tab 顺序：登录 → 模型 → snippet → Demo
- Tab 顺序改为：主页 / 日志 / 设置
- 设置 Tab 只剩"配置"（pool/ttl），登录卡已搬走
- 三个 Tab 高度同步为最高者（JS 测量 + min-height）
- 修 SW panel port disconnected bug

不在本次范围：

- 不动 `extension/manifest.json`、`tests/`、build.mjs、demo 源
- 不内嵌 demo
- 不加 Tab 状态持久化
- 不加新测试（沿用 v0.1.61 决策：DOM 切换无业务逻辑分支可测）
- 不改 demo-shim / popup-helpers 测试

## 2. 术语

| 词 | 含义 |
|---|---|
| Tab Panel | 每个 Tab 对应的内容容器（一次显示一个） |
| syncTabHeight | JS 函数，遍历三个 panel 取 scrollHeight 最大值，统一设 min-height |
| safePostPanel | SW 内 panel port 的带 try/catch 的 postMessage 包装，对齐 deepapi safePost 范式 |
| panelAlive | SW 内 panel port 的存活标记（onDisconnect 时置 false） |

## 3. 总体改动

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/popup/popup.html` | 重排 3 panel 内容；交换 Tab 顺序为"主页/日志/设置"；主页 panel 把登录卡整卡搬入；设置 panel 删登录卡只留配置 |
| 2 | `src/popup/popup.css` | `.tab-panel { overflow: hidden }` 一行；其他规则不动 |
| 3 | `src/popup/popup.ts` | `render()` 末尾调用 `syncTabHeight()`；新增 `syncTabHeight()` 函数（~10 行）；setupTabs 不动 |
| 4 | `src/background/sw.ts` | `deepapi-panel` 分支加 `panelAlive` + `safePostPanel`；3 处裸 `port.postMessage` 改 `safePostPanel`；`panelPorts.delete(port)` 移到 onDisconnect 内（与 panelAlive 同步） |
| 5 | `docs/01.memory.md` | 加 1 条经验教训：SW panel port 必须套 safePost 模式（v0.1.61 漏掉 → v0.1.62 修） |

## 4. Popup 内容映射

### 4.1 Tab 顺序（HTML data-tab 属性）

```
主页 (home, default)  →  日志 (logs)  →  设置 (settings)
```

**改动**：v0.1.61 是 `home / settings / logs`，v0.1.62 调整为 `home / logs / settings`。

### 4.2 主页 Panel（按从上到下顺序）

```
┌─ 登录卡（搬入，原属设置）─────────────┐
│ 状态文字（● 已登录 / ● 未登录 / ● 失效）│
│ [↻ 重新探测] [🔄 立即同步]             │
│ [打开登录页]                            │
├─ 模型卡 ─────────────────────────────┤
│ • deepseek-v4-flash   desc            │
│ • deepseek-v4-pro     desc            │
│ • deepseek-v4-flash-vision-exp        │
├─ 接入 snippet 卡 ───────────────────┤
│ <textarea readonly>...                │
│ [复制 snippet]                        │
├─ Demo 卡 ───────────────────────────┤
│ [↗ Open Demo in new tab]             │
└──────────────────────────────────────┘
```

### 4.3 日志 Panel（不变）

复制按钮 + 说明 `<p class="small">` + `<ul id="log-list">`。

### 4.4 设置 Panel（只剩配置卡）

```
┌─ 配置卡 ─────────────────────────────┐
│ 线程池 [  2 ]                          │
│ TTL 分钟 [  30 ]                       │
└──────────────────────────────────────┘
```

原"登录状态卡"完全移除。

### 4.5 13 个 id 全部保留

```
version, snippet, btn-copy-snippet, model-list, btn-open-demo,
auth-state, btn-refresh-auth, btn-repush-auth, btn-login,
pool-size, ttl-min, btn-copy-log, log-list
```

id 与 id 之间的位置关系改变（搬到不同 panel），但所有 13 个 id **仍存在**（popup.ts 的 event listener 不动）。这是最低耦合改动。

## 5. Tab 高度同步

### 5.1 实现

新增 `syncTabHeight()` 函数：

```ts
function syncTabHeight(): void {
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');
  let max = 0;
  panels.forEach(p => {
    // 强制显示以测量 scrollHeight（隐藏的 panel scrollHeight=0）
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

### 5.2 调用时机

- `render()` 末尾调用一次（每次 SW 推 state 后都同步）
- 不在 `setupTabs()` 里调用（高度应在内容变化时同步，不在 Tab 切换时）

### 5.3 性能

- popup 心跳 2s 一次 + 用户操作触发 render；每 render 一次 syncTabHeight
- 测量时短暂把隐藏 panel 移出屏幕外（visibility:hidden + position:absolute + left:-9999px）保持视觉无闪烁
- 实际性能开销：~10ms/次（用户无感知）

### 5.4 CSS 配合

```css
.tab-panel { display: block; overflow: hidden; }  /* overflow:hidden 防 min-height 计算误差 */
.tab-panel:not(.active) { display: none; }
```

`overflow: hidden` 防止 panel 内部子元素溢出影响 scrollHeight 测量（实测有时 panel 内某元素 margin/padding 让 scrollHeight 比预期大一点点）。

## 6. SW Port Bug 修复

### 6.1 根因

`deepapi-panel` 分支的 3 处 `port.postMessage`（行 290/326/328）无 try/catch、无存活检查。Chrome 关闭 port（popup 关闭 / 扩展 reload / SW 重启）后，残留 `postMessage` 抛 `Attempting to use a disconnected port object`，未在 async listener 内 catch → console unhandled rejection。

### 6.2 修复（对齐 deepapi safePost 范式）

```ts
} else if (port.name === 'deepapi-panel') {
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
          providers: { deepseek: { ...provCfg, models: router.models ? (await router.models()).data : [] } },
          log: (logList?.log as any[]) ?? log.list(),
        },
      });
    } else if (msg?.kind === 'panel.openLogin') {
      await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
    } else if (msg?.kind === 'panel.refreshAuth') {
      await refreshAuthAndLog();
      await broadcastPanelState();
    } else if (msg?.kind === 'panel.repushAuth') {
      /* 不变（不调用 port.postMessage）*/
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

### 6.3 不动 `broadcastPanelState`

第 199 行循环已有 `try { p.postMessage(...) } catch {}` 保护，OK。

### 6.4 不动 `deepapi` 分支

已有 safePost，OK。

## 7. 不改的东西（明确边界）

- `src/popup/snippet.ts`：不变
- `extension/manifest.json`：不变
- `tests/`：不变（决策同 v0.1.61：DOM 切换无业务逻辑分支，不写单测）
- `build.mjs`：不变
- 历史文档（`docs/superpowers/specs/2026-09-08-*`、`docs/superpowers/plans/2026-09-08-*`）：保留
- `popup.html` 的 13 个 id 全保留（位置关系变，但所有 id 仍在对应 panel 内）
- `setupTabs()` 函数本身不变（v0.1.61 实现 OK）

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Tab 内容重排后 popup.ts 的 event listener 漏绑定 | 高 | 13 个 id 全保留，listener 用 `document.getElementById` 不变；build 成功后跑 `npm test` 兜底（虽然 popup 无单测，但 esbuild 编译过=语法 + 类型 OK） |
| syncTabHeight 测量误差导致 Tab 跳动 | 中 | 用 visibility:hidden + position:absolute 测量，无视觉闪烁；测量后立即复位 |
| SW safePostPanel 漏掉某处 port.postMessage | 中 | review 阶段 grep 验证 `src/background/sw.ts` 内 `port.postMessage` 全部在 try/catch 或 safePostPanel 内 |
| 三个 panel 改 Tab 顺序后 `panel.listLogs` / `panel.ping` handler 出错 | 低 | 逻辑不变；只换 Tab 顺序不影响 SW panel.* 协议 |

## 9. 验收标准

- [ ] popup.html Tab 顺序：`home / logs / settings`（data-tab 属性值）
- [ ] 主页 panel 含 4 个卡：登录卡、模型卡、snippet 卡、Demo 卡
- [ ] 日志 panel 含：复制按钮 + 说明 p.small + log-list
- [ ] 设置 panel 含：配置卡（pool-size + ttl-min），**无**登录卡
- [ ] 13 个 id 全部存在（grep 校验）
- [ ] popup 默认打开显示主页 Tab
- [ ] 三个 Tab 高度一致（取最高者 min-height）
- [ ] popup.ts `render()` 末尾调用 `syncTabHeight()`
- [ ] `src/background/sw.ts` 的 3 处裸 `port.postMessage` 全部改为 `safePostPanel(...)`
- [ ] `src/background/sw.ts` 加 `panelAlive` + `safePostPanel` 定义
- [ ] `src/background/sw.ts` onDisconnect 同时设 panelAlive=false + panelPorts.delete
- [ ] esbuild 编译 popup.ts 通过
- [ ] `npm test` 全绿（19 files / 117 tests）
- [ ] `npm run build` 成功，extension/popup.js + sw.js 产物正常
- [ ] docs/01.memory.md 加 1 条经验教训
- [ ] README 不变（无需更新）
- [ ] 版本 bump v0.1.61 → v0.1.62
