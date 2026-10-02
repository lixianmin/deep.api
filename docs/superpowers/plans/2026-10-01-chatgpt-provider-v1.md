# ChatGPT provider v1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `gpt-*` 模型名打到 chatgpt.com 网页版，经页面桥接流式返回。**只做文本 + 流式 + 多轮。**

**Architecture:** 三段链路——MAIN world content script（`document_start` 注入 chatgpt.com）挂钩页面自己的 `window.fetch` 并驱动 composer 发送；ISOLATED relay 只做世界间转发；SW 侧 adapter 把 SSE 帧解释成 `ProviderStreamEvent`。**扩展自己从不直接请求 ChatGPT**（sentinel iframe 握手无法在 SW 复现，且账号安全调研已确认 SW 请求永远不是浏览器形状）。

**Tech Stack:** TypeScript 5.9、vitest 2.1、esbuild、MV3、bun

**Spec:** `docs/superpowers/specs/2026-10-01-chatgpt-page-bridge-design.md`
**协议实测（唯一权威，勿凭记忆）:** `docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md`

## Global Constraints

- **`bun run test` 全绿（基线 555），`tsc --noEmit` 0 错误。**
- 不得引入新依赖。注释用中文解释「为什么」。
- **不得提交任何 `expect` 期望值改动**（本阶段只新增测试文件）。
- 提交首行 ≤72 字符。合并走 `scripts/merge.sh`。
- **v1 范围铁律**：不支持 tool_calls / vision / search（`reasoning` 例外，见文首修正）。收到这些参数**必须显式报错**，不能静默忽略（静默忽略会让 spice 以为能力存在）。

## 关键实测约束（来自协议文档，违反即 bug）

- 钩子必须 `document_start` 注入 MAIN world，**运行期注入无效**。
- 正文 path 是 `/message/content/parts/0`，op `append`。
- **`p`/`o` 跨帧继承**：只带 `{"v":"..."}` 的帧沿用上一条 delta 的 `p`/`o`。
- `{"p":"","o":"patch","v":[...]}` 是操作数组，需再展开一层。
- 推理/正文分界看 `{"type":"message_marker","marker":"final_channel_token"}`。
- 结束信号 `{"type":"message_stream_complete"}`，流末 `data: [DONE]`。
- **新会话请求体不传 `conversation_id`**；会话 id 由 `resume_conversation_token` 帧回传。
- composer 必须是 `#prompt-textarea`（contenteditable）；未水合时会退化成 `wcDTda_fallbackTextarea`，此时点 send 只是 GET 导航，**不算发送**。
- **不能用 send 按钮存在与否判断就绪**（它要等有文字才出现，鸡生蛋死锁）。

> **实施后修正（2026-10-02）**：Task 4 的 v1 守卫原按本计划把 `reasoning` 也列入 400 拒绝，
> 但 debug 页 reasoning 下拉默认 high 且每次请求都带，导致 **ChatGPT 在 debug 页完全不可用**
> （用户实测截图）。已改为 **`reasoning` 接受但忽略**（是否思考由 ChatGPT 网页侧自主决定，
> 桥接无透传通道，抛错换不来「不思考」）。tools / vision / search=true 仍拒。
> 下方「v1 范围铁律」中 reasoning 的表述以此修正为准。

## Review Focus

1. `p`/`o` 继承：只带 `v` 的帧必须沿用上一帧的 path——写错会让正文整段丢失或重复。
2. `patch` 数组内的 append 必须与顶层 append 同等处理。
3. `final_channel_token` 之前的正文必须是 `think_delta`，之后才是 `content_delta`。
4. 请求/流配对：并发两个请求时不能把 B 的流配给 A。
5. v1 范围外参数（tools/vision/reasoning/search）必须**报错**而非忽略。
6. 页面导航导致 port 断开后必须能恢复，不得永久挂死。

---

### Task 1: SSE 拆帧与解析（纯函数）

**Files:**
- Create: `src/shared/chatgpt-sse.ts`
- Test: `tests/unit/chatgpt-sse.test.ts`（新建）

**Interfaces — Produces:**
```ts
export interface SseFrame { event: string | null; data: string }
/** 按 SSE 空行切帧。返回完整帧与未成帧的残留。 */
export function splitFrames(buffer: string): { frames: string[]; rest: string }
/** 解析单帧；不成帧返回 null。data 原样保留（可能是 JSON、字符串或 [DONE]）。 */
export function parseFrame(raw: string): SseFrame | null
```

- [ ] **Step 1: 写测试** —— 覆盖：`data: [DONE]`、`event: X` + `data: {...}`、跨 chunk 被切断的一帧（`rest` 语义）、`\n\n` 切分、空帧/无 data 帧返回 null。
- [ ] **Step 2: 跑测试确认失败** —— `bunx vitest run tests/unit/chatgpt-sse.test.ts` 应 FAIL（模块不存在）。
- [ ] **Step 3: 实现** `splitFrames` + `parseFrame`。`splitFrames` 用 `\n\n` 切；`parseFrame` 逐行扫 `event:` / `data:`，**data 行要剥掉一个前导空格**；`data` 保留原始字符串不解析 JSON。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** `git commit -m "feat(chatgpt): SSE 拆帧与解析纯函数"`

---

### Task 2: SW 侧帧解释器

**Files:**
- Create: `src/background/providers/chatgpt/stream.ts`
- Test: `tests/unit/chatgpt-stream.test.ts`（新建）

**Interfaces — Consumes:** `SseFrame` from Task 1
**Interfaces — Produces:**
```ts
export interface ChatGPTStreamState { lastP: string; lastO: string; phase: 'reasoning' | 'content' }
export function interpretFrame(frame: SseFrame, state: ChatGPTStreamState): ProviderStreamEvent[]
export function newStreamState(): ChatGPTStreamState
```

- [ ] **Step 1: 写测试** —— 用协议文档里的**真实帧文本**做夹具，至少覆盖：`delta_encoding`、带 `p`/`o` 的正文 append、**只带 `v` 的续帧（继承）**、`p:""`+`o:"patch"` 数组内的 append、`final_channel_token` 前后的通道切换、`message_stream_complete`、`[DONE]`、`title_generation` 忽略、error 字段非空。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** `interpretFrame`：
  - 忽略 `delta_encoding` / `title_generation` / `server_ste_metadata` / `conversation_followup_suggestions_eligible`（返回 `[]`）
  - `message_marker` 且 `marker === 'final_channel_token'` → `phase = 'content'`
  - `message_stream_complete` → 产出终止事件（按 `adapter.ts` 现有事件集实现终态）
  - `resume_conversation_token` → 产出携带 `conversationId` 的事件
  - `delta` 帧：取 `p`/`o`，**缺省时沿用 `state.lastP/lastO`**；命中 `/message/content/parts/0` 且 `o==='append'` 且 `v` 是 string → 按 `state.phase` 产出 `think_delta` 或 `content_delta`；`o==='patch'` → 递归展开 `v` 数组逐项处理
  - error 字段非空 → 产出让 router 能抛错的 stream_error 事件
- [ ] **Step 4: 跑测试确认通过** + `bun run test` 全绿。
- [ ] **Step 5: 提交** `git commit -m "feat(chatgpt): SSE 帧 → ProviderStreamEvent 解释器"`

---

### Task 3: MAIN world 桥接脚本

**Files:**
- Create: `src/content/chatgpt-bridge-main.ts`
- Test: `tests/unit/chatgpt-bridge-send.test.ts`（新建，jsdom）

**Interfaces — Produces（window 事件契约）:**
- 接收（来自 relay 的 `window.postMessage`）：`{ __deepApiChatGPT: 'send', requestId, text, conversationId | null }`
- 发出：`window.postMessage({ __deepApiChatGPT: true, kind, requestId, ... }, '*')`，`kind ∈ 'stream-start' | 'frame' | 'conversation' | 'done' | 'error'`

- [ ] **Step 1: 写测试**（jsdom）——把「驱动 composer 发消息」的核心逻辑抽成**可测纯函数** `waitForComposer(doc) / fillComposer(el, text) / findSendButton(doc)`，测试覆盖：未水合时 `waitForComposer` 返回 null（**不得**退化成 fallback textarea）、正常填入、清空已有内容后再填。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：
  - `document_start` 时 patch `window.fetch`（模块作用域捕获，故必须此刻）
  - 命中 `/backend-api/f/conversation` 时：`res.clone()` 旁路读，喂给 `splitFrames`，每帧 `postMessage` 出去；`[DONE]` 或 `message_stream_complete` → 发 `done`
  - 收到 `send` 指令：记 `activeRequestId` → 确保页面在目标会话 → `fillComposer` → 等 send 按钮（**只在有文字之后等**）→ 点击
  - 会话切换：目标 `conversationId` 为 null → 需在「新会话」状态；否则 `location.assign('/c/' + id)`，**等页面重新水合**（脚本会重新注入，故待发指令要能跨导航恢复——见 Step 4）
  - 忽略 `/f/conversation/prepare` 与其它 URL
- [ ] **Step 4: 处理导航跨恢复** —— 把待发指令存 `sessionStorage`（跨同源导航保留），新文档加载后取回继续。**这一步必须有测试**覆盖"存→取"往返。
- [ ] **Step 5: 跑测试确认通过** + `bun run test` 全绿。
- [ ] **Step 6: 提交** `git commit -m "feat(chatgpt): MAIN world 桥接（挂 fetch + 驱动 composer）"`

---

### Task 4: ISOLATED relay + SW 侧 adapter

**Files:**
- Create: `src/content/chatgpt-bridge-relay.ts`
- Create: `src/background/providers/chatgpt/adapter.ts`
- Create: `src/background/providers/chatgpt/bridge-client.ts`
- Modify: `src/background/sw.ts`（注册 adapter + 转发 relay 消息）
- Modify: `manifest.json`（两个 content script）
- Modify: `build.mjs`（两个 entry）
- Test: `tests/unit/chatgpt-adapter.test.ts`（新建）

- [ ] **Step 1: 写测试** —— adapter 契约：models 列出 `gpt-5-5` 等；`resolveModel` 接受 `gpt-*` 拒绝未知；`streamCompletion` 在收到 `frame` 后产出对应事件、收到 `done` 后结束；`getAuthStatus` 无桥接时返回 `logged_out`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 relay** —— 双向 `window.postMessage` ↔ port，只转发 `__deepApiChatGPT` 相关消息，用 `__deepApiChatGPT === true` 过滤外来消息。
- [ ] **Step 4: 实现 bridge-client（SW 侧）** —— 管理 port 连接与断线重连；`request(requestId, text, conversationId)` 返回 `AsyncIterable<ProviderStreamEvent>`；**超时**（默认 120s）后抛错并从 pending 表移除，不得永久挂起。
- [ ] **Step 5: 实现 adapter** —— `streamCompletion` 走 bridge-client；`models` 用实测到的 `gpt-5-5 / 5-6 / 5-3-mini / 5-5-mini / 5-6-mini / auto`；**v1 范围守卫**：请求带 `tools` / 图片 content / `reasoning` / `search` 时抛 `400 invalid_request_error` 并说明 v1 不支持（**不静默忽略**）。
- [ ] **Step 6: 接线** —— `sw.ts` 里 `createRegistry(deepseekAdapter, chatgptAdapter)`；`manifest.json` 加两个 content script（MAIN + ISOLATED，均 document_start，`matches: ["https://chatgpt.com/*"]`）；`build.mjs` 加两个 entry。
- [ ] **Step 7: 跑全量 + tsc** → `bun run test && bunx tsc --noEmit`。
- [ ] **Step 8: 提交** `git commit -m "feat(chatgpt): relay + adapter + 注册到 registry"`

---

### Task 5: 端到端手工验收

**Files:** 无代码改动（除非验收暴露 bug，另开修复轮）

- [ ] **Step 1: build** → `bun run build`
- [ ] **Step 2: 人工验收**（需人类在真实 Chrome 操作）
- [ ] **Step 3: 记录结果**到 `docs/01.memory.md`（含真实 conv id 便于复查）

验收步骤（人类执行）：
1. `chrome://extensions` 刷新扩展；关掉所有 chatgpt.com 标签页
2. 新开 `https://chatgpt.com/`，确认已登录
3. 用 curl 直打扩展的接口，body 用 `{"model":"gpt-5-5","stream":true,"messages":[{"role":"user","content":"用一句话介绍你自己"}]}`
4. **判据**：分块陆续到达（不是一次性）、内容是模型回复、第二次带同一 `conversation_id` 的请求接在同一会话上继续

---

## 完成判据

- [ ] `bun run test` 全绿，`tsc --noEmit` 0 错误
- [ ] `grep -rn "sidebar/conversation" src/` 无结果（别把旧路径写回去）
- [ ] v1 范围外参数确实报 400
- [ ] `scripts/merge.sh` 退出码 0
