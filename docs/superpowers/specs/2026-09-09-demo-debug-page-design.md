# demo 页改造：Demo → Debug 仪表盘

- 日期：2026-09-09
- 版本：v0.1.66（manifest.json + extension/manifest.json + package.json）
- 状态：设计稿待用户审

## 目标

把 popup 里 "Open Demo in new tab" 打开的页面（`src/demo/demo-page/`）从「6 个场景按钮 + 输出框」的演示形态，升级为类浏览器 DevTools 的调试仪表盘。新增 Chat 形式的正常对话流。旧版「修改历史重发（rebuild）」按钮仍保留在「场景」tab 下，因为它是 deep.api 已实现路由分支（`session-mapper.ts:50` `decide()`）的真实演示入口，不删除。

## 范围

### 包含

1. 5 个 tab 的调试仪表盘：Chat / 路由 / 日志 / SSE 帧 / 场景。
2. SW 侧新增拉模式接口 `panel.listThreads()`，让 debug 页能拉到 thread 表。日志沿用现有 `panel.listLogs`（sw.ts:340，已在用）。
3. `RingLog` 容量从 200（sw.ts:68 现状）调到 500：debug 页「日志」tab 滚动区能多看几轮决策现场；不影响 popup（popup 只展示最近 20 条，不读全量）。
4. 「场景」tab 新增「全部跑」按钮（顺序执行 6 个场景，结果以表格呈现）。
5. `build.mjs` 同步把新增 demo 模块拷到 `extension/demo/`。

### 不包含（YAGNI）

1. Chat history 持久化（in-memory 即可，刷新即丢，调试场景不需要跨刷新记忆）。
2. popup 折叠面板同步改造（`src/demo/demo-runner.ts` 保留原 `mountDemo` 给 popup 用，popup 体验不变）。
3. 路由 tab 的破坏性操作（重建 / 编辑 mirror / 删 thread）—— v1 只读。
4. 场景并发跑 / 循环 / 调度依赖——v1 只支持顺序单次「全部跑」。
5. 视觉模型场景——vision 按钮从 demo 中删除（v1 未启用，参考 memory「Vision 未启用 v0.1.37」），不再保留禁用占位。
6. 实时推送日志（push 模式会撑爆 SW postMessage）——一律拉模式（手动 + 30s 自动）。

## 架构

### 数据流

```
demo 页（同源 chrome-extension://.../demo/index.html）
  ├─ mountDebugPanel(rootEl)
  │    ├─ tab 框架 + URL hash 路由（#chat / #routing / #log / #sse / #scenarios）
  │    └─ 按当前 hash 渲染对应 tab
  │
  └─ chat.completions.create / models.list 调用
       └─ demo 页 chrome.runtime.connect({ name: 'deepapi' })
            └─ bridge-relay (ISOLATED world content script，所有页面注入)
                 └─ SW 接收 → log.add → ring buffer → router → provider → SSE 回推

拉数据（debug 页专用，复用现有 panel 通道）：
  demo 页 → chrome.runtime.connect({ name: 'deepapi-panel' }) → SW
       └─ 发送 { kind: 'panel.listLogs' }     // 沿用 sw.ts:340
       └─ 发送 { kind: 'panel.listThreads' }  // 新增
       └─ SW 返回 { kind: 'state', payload: { log: [...] } / { threads: [...] } }
```

不新增推送通道，沿用 popup 现有的 `deepapi-panel` 长连接（v0.1.62 已加 `safePostPanel` 护栏）。

### 文件改动

**新增**：

- `src/demo/debug-panel.ts` — tab 框架、URL hash 路由、5 个 tab 的 lazy 挂载入口。
- `src/demo/tabs/chat.ts` — Chat tab 渲染 + 消息流 UI + 右键菜单。
- `src/demo/tabs/routing.ts` — 路由 tab：thread 表格 + 拉刷新。
- `src/demo/tabs/log.ts` — 日志 tab：滚动列表 + 过滤（普通 overflow，不实现真虚拟滚动）。
- `src/demo/tabs/sse.ts` — SSE 帧 tab：按 request_id 分组。
- `src/demo/tabs/scenarios.ts` — 场景 tab：6 按钮 + 「全部跑」+ 结果表格。
- `src/demo/tabs/panel-api.ts` — 封装 `panel.listLogs` / `panel.listThreads` 调用（异步单例 port 共享，避免反复 connect）。

**重写（极简化）**：

- `src/demo/demo-page/index.html` — 仅 `<div id="root">` + `<script src="debug.js">`，不再含场景按钮。
- `src/demo/demo-page/demo.js` — 仅调用 `mountDebugPanel(document.getElementById('root'))`。

**保留不动**：

- `src/demo/demo-runner.ts` — 仍提供 `mountDemo`，仅 popup 折叠面板使用。

**修改**：

- `src/background/sw.ts:68` — `new RingLog(200)` → `new RingLog(500)`；新增 `panel.listThreads` 消息分支。
- `src/background/session-mapper.ts` — 加 `listThreads()` 导出，返回从 `ThreadEntry[]` 映射的 `ThreadRow[]`（`lastDecision` 从 `log.list()` 聚合，不持久化在 ThreadEntry 上）。
- `build.mjs` — 现有 `src/demo/demo-page/*` 拷贝逻辑保留，新增 `src/demo/{debug-panel.ts,tabs/*.ts}` 打包与拷贝。
- `docs/01.memory.md` — 追加本次改动关键决策（debug 页 tab 结构、panel.listThreads 契约、RingLog 容量调整原因、rebuild 按钮保留原因）。

**复用现有**（不改）：

- `src/background/log.ts` — `LogEntry` 形状（log.ts:5）和 `RingLog` 类（log.ts:32）已就位，`log.list()` 已返 `[...buf]` 快照。
- `src/background/sw.ts:340` — `panel.listLogs` 已实现，直接复用，不重写。

## Tab 详细设计

### 1. Chat tab

- **UI**：顶部消息流（user 右对齐、assistant 左对齐，含 reasoning_content 时折叠展示）+ 底部输入框（textarea + 发送按钮，支持 Enter 发送 / Shift+Enter 换行）。
- **history**：in-memory 数组，刷新即丢；不写 storage。
- **调用契约**：与 OpenAI SDK 一致——`messages` 数组含完整历史（含 assistant 回复），deep.api 由 SessionMapper 处理 mirror（memory 关键决策 #9）。
- **右键菜单**（每条消息右键）：
  - 「复制为 messages JSON」—— 把当前消息及之后的所有消息作为 `messages` 数组复制到剪贴板。
  - 「复制为 curl」—— 生成等价的 `curl -N` 命令（含 SSE 流 headers / body）。
  - 「从此处重发」—— 删除该条 user 消息及之后所有消息（含 assistant / tool 回复），把被删的 user 内容作为新 prompt 重发一次。**会触发 rebuild**：当前 thread 的 mirror 失去最后几条，与新 messages 不匹配 → SessionMapper 判 rebuild → 开新 web session。这是 deep.api v1 设计行为（参考 memory「运行时编辑已发送消息」条目）。执行前弹一个 confirm 对话框说明副作用。
- **模型选择**：复用顶部「① 通用参数」面板的 model / thinking / search / reasoning_effort 控件（跨 tab 可见，状态共享）。
- **流式渲染**：SSE chunk 实时拼接，`reasoning_content` 折叠区可展开。

### 2. 路由 tab

- **表格列**：`conversationId` / `kind`（auto / named）/ `mirrorLen` / `lastDecision`（从 log 聚合，rebuild / incremental / 空）/ `lastUsedAt`（相对时间「X 分钟前」）/ `busy` / `webSessionId`（缩略）。
- **拉刷新**：手动「刷新」按钮 + 进入 tab 时自动拉一次 + tab 停留期间 30s 轮询。
- **来源**：`SessionMapper.listThreads()`，遍历 `threads.values()` + 聚合 log。
- **只读**：不提供删除 / 编辑 / 主动 rebuild 按钮。
- **空状态**：「暂无 thread——发起一次 Chat 或场景调用后会出现在此。」

### 3. 日志 tab

- **列表**：时间倒序滚动列表（每条一行：`at` / `provider` / `model` / `ok` / `ms` / `action` / `error` / `replySample`）。最多 500 行（v0.1.66 调整 RingLog 容量后）；普通 CSS overflow 滚动即可，不实现真虚拟滚动（§3 YAGNI：500 行在现代浏览器里 ~50ms render + OK scroll，性能足够）。
- **过滤**：
  - `action` 多选：rebuild / incremental / error / undefined。
  - `ok` 多选：true / false。
  - 文本搜索：子串匹配 `error / replySample / cid`。
- **拉刷新**：手动「刷新」按钮 + 30s 轮询。
- **来源**：`panel.listLogs` 返回的 `log: LogEntry[]`（最多 500 条，v0.1.66 调整后容量）。
- **复制行**：每条日志「复制完整 JSON」按钮，复制 `messagesFull + mirrorFull + replySample` 等所有诊断字段。
- **清空**：不提供清空（ring buffer 自身就是 500 上限，旧条目自然淘汰）。

### 4. SSE 帧 tab

- **分组**：按 `webSessionId` 分组（每个 Chat Completions 调用一个 web session 分组；与路由 tab 的 webSessionId 对齐）。
- **每组展示**：`webSessionId` / 起止时间 / `replySample`（200 字内）/ 展开按钮。
- **展开后**：每帧一行（`data: {...}` 或 `data: [DONE]`），可点开单帧查看完整 JSON。
- **拉刷新**：同日志 tab。
- **来源**：复用 `panel.listLogs`，按 `webSessionId` 分组聚合 `replySample`；v1 不单独存 SSE 原始帧，诊断够用即可。

### 5. 场景 tab

- **6 个场景按钮**：非流式问答 / 流式问答 / 工具调用 (auto) / 工具调用 (required) / 修改历史重发 (rebuild) / conversation_id 续聊。
- **「全部跑」按钮**：右上角，一次顺序跑完 6 个场景；任意场景失败不中断后续，结果表格中失败行标红。
- **取消语义**：软取消——点击「取消」后，等待**当前正在跑的**场景的 `await` 返回后，检查 cancel flag 不再发起下一个场景；不会中断已经在飞的 SSE 帧。已跑完的保留在结果表里，状态为「已取消」未跑的不显示（仅显示已完成项）。
- **结果表格**：列「场景 / 通过 / 耗时 / 错误」；点击行展开原始输出（dump 出的 messages + choice 摘要）。

## SW 面板接口契约

走现有 `deepapi-panel` 长连接（与 `panel.getState` 同通道），复用 v0.1.62 的 `safePostPanel` 护栏。沿用现有消息格式 `{ kind: 'panel.xxx' }`，**不**走 `__deepApi` 包装（panel 通道与业务通道分离）。

### 沿用：`panel.listLogs`（sw.ts:340 已实现）

```ts
// 请求
{ kind: 'panel.listLogs' }
// 响应
{ kind: 'state', payload: { log: LogEntry[] } }   // 最多 500 条（v0.1.66 调整容量后）
```

`LogEntry` 形状沿用 `src/background/log.ts:5` 的现有定义，**不在本次范围内扩展字段**：

```ts
interface LogEntry {
  at: number;                                       // epoch ms
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
  cid?: string;                                     // conversation_id
  msgsLen?: number;
  action?: 'rebuild' | 'incremental' | 'error';     // 路由决策
  threadFound?: boolean;
  mirrorLen?: number;
  deletedOld?: boolean;
  webSessionId?: string;
  parentMessageId?: string | number | null;
  finishReason?: string;
  firstDiffIdx?: number;
  messagesFull?: string;                            // 完整 messages JSON（复制用）
  mirrorFull?: string;                              // 完整 mirror JSON（复制用）
  replySample?: string;                             // 模型原文前 200 字
}
```

debug 页「日志」tab 直接消费：`log` 数组按 `at` 倒序，文本搜索匹配 `error / replySample / cid`，过滤面板提供 `action` 多选（rebuild / incremental / error / undefined）和 `ok` 多选（true / false）。

### 新增：`panel.listThreads`

```ts
// 请求
{ kind: 'panel.listThreads' }
// 响应
{ kind: 'state', payload: { threads: ThreadRow[] } }

interface ThreadRow {
  conversationId: string;                           // 来自 ThreadEntry.conversationId
  kind: 'auto' | 'named';                           // 来自 ThreadEntry.kind
  mirrorLen: number;                                // ThreadEntry.mirror.length
  webSessionId: string;
  parentMessageId: string | number | null;
  lastUsedAt: number;                               // epoch ms，相对时间「X 分钟前」
  busy: boolean;
  // 聚合字段：从最近一次该 cid 的 log entry 拿 decision，不持久化在 ThreadEntry 上
  lastDecision?: 'rebuild' | 'incremental' | 'error';
  lastDecisionAt?: number;                          // 最近一次 log entry.at
}
```

实现位置：`src/background/session-mapper.ts` 新增 `listThreads(): ThreadRow[]`，遍历 `threads.values()`，对每条 thread 查 `log.list()` 中 `cid === t.conversationId` 的最近一条，把 `action` 字段映射为 `lastDecision`。O(n·m) 在 500 条 log × 几十个 thread 下可忽略；如有性能问题留 v2 再议。

## 测试

### 单元（vitest）

1. `mountDebugPanel(root)`：渲染后 `root.querySelectorAll('[data-tab]').length === 5`。
2. URL hash 切换：`#routing` → DOM 含 `[data-tab="routing"][data-active="true"]`，其他 tab `data-active="false"`。
3. `SessionMapper.listThreads()`：空 Map 返回 `[]`；有 entries 返回 `ThreadRow[]` 形状（含 `lastDecision` 从 log 聚合）。
4. `panel-api` 单例：连续调用 `listLogs()` / `listThreads()` 复用同一 long-lived port，不创建新连接。
5. `runAllScenarios` 软取消：跑完第 3 个场景后点取消，第 4 个场景不再发起，第 3 个的 await 自然完成后整体 promise resolve，结果表只有 3 行。

### 集成（vitest + mock SW）

1. mock SW 收到 `panel.listLogs`：返回 `log.list()` 快照（最多 500）。
2. mock SW 收到 `panel.listThreads`：返回 `SessionMapper.listThreads()` 序列化结果。

### 手动验收（chrome 加载 extension/）

1. 加载 v0.1.66，登录 chat.deepseek.com。
2. 打开 demo 页 → 5 个 tab 都在；URL hash 同步。
3. Chat tab：发一条消息 → 看到 SSE 流；右键消息 → 复制为 messages JSON 成功。
4. 路由 tab：先发一条 Chat → 表格出现 1 行；「刷新」按钮正常。
5. 日志 tab：kind 过滤生效；搜索子串命中。
6. SSE 帧 tab：流式调用后展开分组看到多帧。
7. 场景 tab：6 按钮各自正常；「全部跑」跑完表格 6 行全绿（或失败标红）。
8. 路由决策（rebuild）：场景「修改历史重发」点两次 → 第二次路由面板看到 `lastDecision: 'rebuild'`、`mirrorLen: 2`（首轮 commit 2 条消息：user '2+2 等于几？' + assistant '4'；重发触发 rebuild 后旧 thread mirrorLen 保持 2，新 thread 不在此面板）。

## 风险与对策

1. **popup 折叠面板仍用旧 mountDemo**：v0.1.66 不动 popup；未来 popup 升级作为独立 PR（避免本 PR 爆炸）。文档中明确这一边界。
2. **SW postMessage 撑爆**：拉模式 + 30s 间隔 + 单例 port 共享三重护栏。
3. **log ring buffer 容量调整影响现有 popup 行为**：popup 展示的是最近 20 条，容量从 200 调到 500 后，popup 行为不变（不读全量）；内存占用从 ~200 条 JSON 升到 ~500 条，可忽略。
4. **build.mjs 漏拷新文件**：esbuild 打包 `debug.js` 一个入口文件，所有 tab 模块 inline 进 bundle，build.mjs 只额外拷 HTML 即可。
5. **多 tab 同时挂载导致 DOM 抢占**：tab 框架只渲染当前 active tab，其他 tab DOM 不存在（lazy mount）；切换时前一个 unmount。
6. **「全部跑」在 rebuild 场景触发真实副作用**：rebuild 会删旧 thread、DeepSeek 网页端出现两个 chat thread——这是 v1 设计行为，已在 demo 注释里说明；不在 debug 页改造范围。
7. **listThreads 聚合 log O(n·m)**：500 × 几十 < 30000 操作，每 30s 一次，可忽略；性能有问题留 v2。

## 版本与发版

- `npm run bump` 后为 v0.1.66
- `npm run build` → `extension/` 包含新 `demo/debug.js` 等
- 用户 chrome://extensions 移除旧版 → 重新加载 `extension/`
- commit message：`feat(demo): convert demo page into Debug dashboard with 5 tabs (Chat/Routing/Log/SSE/Scenarios)`

## 不在本文档范围

- popup 折叠面板升级（独立 PR）
- 主动 rebuild / 编辑 mirror / 破坏性工具（v2 再议）
- vision 场景复活（独立 PR + ref_file_ids 上传链路 spike）
- listThreads 性能优化（v2 再议）
