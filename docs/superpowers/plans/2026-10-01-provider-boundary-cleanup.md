# provider 边界清理：拆 labelToModelId + 删 limitCharsFor 死代码 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除两处架构异味——(1) service worker 反向依赖 content script 模块、(2) 一条无人调用的死函数。**零行为变化。**

**Architecture:** 把 `labelToModelId` 及其正则表从 DOM 抓取脚本中拆到纯模块，让 background 不再 import content script；`limitCharsFor` 连同其测试整体删除。

**Tech Stack:** TypeScript 5.9、vitest 2.1、esbuild、bun

**Spec:** `docs/superpowers/specs/2026-10-01-chatgpt-page-bridge-design.md` §4 架构泄漏表第 5 行（models-sync 被 router import）

## Global Constraints

- **验收基线：`bun run test` 现有 543 个测试全绿。** 只允许**新增**用例与**改 import 行**；**不得改动任何 `expect` 断言的期望值或结构**。
- `bunx tsc --noEmit` 0 错误。
- 不得引入任何新依赖。
- 注释用中文解释「为什么」；不得留孤儿注释/孤儿导出。
- 提交信息首行不超过 72 字符。
- 合并走 `scripts/merge.sh`，不手敲 rebase/merge/push。

## 本阶段明确不做

- **`modelType` → 中性 `variant` 的重命名**（10 个测试文件 62 处引用，且需要改大量现有断言）。
  用户已决定推迟。与接 ChatGPT（阶段 B）一并做时，variant 才有第二个真实使用者，回报最明确。

## Review Focus

1. **拆分后 `labelToModelId` 行为必须完全一致**——正则表原样搬移，一个字符都不许改。
2. **background 侧不得再出现 `content/` 的 import**（`router.ts` 当前 import 的是 content script）。
3. **删除 `limitCharsFor` 后不得有残留引用**——包括 import、测试、以及任何字符串形式的使用。
4. **content script 仍能正常工作**——`models-sync.ts` 自己要用 `labelToModelId`，拆走后它必须从新模块 import，不能变成未定义。

---

### Task 1: 把 `labelToModelId` 拆到纯模块

**Files:**
- Create: `src/shared/model-labels.ts`（新模块，纯函数无 DOM 依赖）
- Modify: `src/content/models-sync.ts`（删 `LABEL_PATTERNS` + `labelToModelId` 定义，改为从新模块 import）
- Modify: `src/background/router.ts:5`（改 import 来源）
- Modify: `tests/unit/models-sync.test.ts:2`（改 import 行，**不动断言**）
- Test: `tests/unit/model-labels.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  // src/shared/model-labels.ts
  export function labelToModelId(label: string): string | null;
  ```
  `LABEL_PATTERNS` 是模块私有的，**不导出**。

**已核实的事实（勿重新论证）**：`src/content/models-sync.ts` 全文 203 行，只有
`router.ts:5` 一个跨界引用者（import 它的 `labelToModelId`）。`LABEL_PATTERNS` 是
4 条 `{re, id}` 常量，`labelToModelId` 是纯字符串处理——两者都**不碰 DOM**，
可从抓取脚本中干净剥离。该文件其余部分（`extractModelOptions` / `startWith` /
`sendCatalogUpdate`）确实需要 DOM，留在原地。

- [ ] **Step 1: 写失败测试 —— 新模块可独立导入且行为一致**

新建 `tests/unit/model-labels.test.ts`，从 `src/shared/model-labels` 导入
`labelToModelId`，覆盖 4 条正则各自对应的 label：
`'default'` → `'deepseek-flash'`、`'DeepSeek V4.1 Flash'` → `'deepseek-flash'`、
`'DeepSeek V4 Flash Vision Exp'` → `'deepseek-v4-flash-vision-exp'`、
`'DeepSeek V4 Pro'` → `'deepseek-v4-pro'`；另测不匹配返回 `null`、空串返回 `null`。

**当前应失败**——模块还不存在。

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run tests/unit/model-labels.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 建 `src/shared/model-labels.ts`**

把 `content/models-sync.ts` 里的 `LABEL_PATTERNS` 常量（4 条，正则**逐字照搬**，
不要"顺手整理"）与 `labelToModelId` 函数整体移入。只保留这两样，不带任何 DOM 代码。
文件头注释用中文说明：为什么它独立于 content script（background 侧需要它，
而它不依赖 DOM，留在抓取脚本里会造成 SW → content script 的反向依赖）。

- [ ] **Step 4: 改三处 import**

- `src/content/models-sync.ts`：删除本地的 `LABEL_PATTERNS` 与 `labelToModelId` 定义，
  改为 `import { labelToModelId } from '../shared/model-labels';`
  （注意它自己内部也要用 `labelToModelId`——见 `extractModelOptions` 或 trigger 逻辑，
  确认 import 后内部调用仍能解析）
- `src/background/router.ts:5`：`from '../content/models-sync'` →
  `from '../shared/model-labels'`
- `tests/unit/models-sync.test.ts:2`：把 `labelToModelId` 从 `content/models-sync`
  的 import 列表里摘出来，改从 `../../src/shared/model-labels` 导入；
  其余三个（`extractModelOptions` / `sendCatalogUpdate`）**保持原处不动**

- [ ] **Step 5: 验证跨界依赖已消除**

Run: `grep -rn "from '\.\./content/" src/background/` && echo "❌ 仍有跨界 import" || echo "✅ background 不再 import content"
Expected: 无输出（`register-catalog-listener.ts` 若有 import 请核实是否类型-only）

- [ ] **Step 6: 跑全量 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 543 + 4 = 547 passed，tsc 0 错误。**若有测试红，先查是不是 import 改漏，
不要改断言。**

- [ ] **Step 7: 提交**

```bash
git add src/shared/model-labels.ts src/content/models-sync.ts src/background/router.ts tests/unit/models-sync.test.ts tests/unit/model-labels.test.ts
git commit -m "refactor(models-sync): labelToModelId 拆到纯模块，去掉 SW→content 反向依赖"
```

---

### Task 2: 删除 `limitCharsFor` 死代码

**Files:**
- Modify: `src/background/transcript-renderer.ts`（删整个函数 + 其注释）
- Modify: `tests/unit/transcript-renderer.test.ts`（删对应的 `describe('limitCharsFor')` 块）

**Interfaces:**
- Consumes: 无
- Produces: `transcript-renderer` 模块不再导出 `limitCharsFor`

**已核实的事实（勿重新论证）**：`limitCharsFor` 在**生产代码中零调用点**。
上一轮已把 `router.ts` 里对它的死 import 删掉（commit 26e26a1）。它当前唯一的
调用方是 `tests/unit/transcript-renderer.test.ts`。整条链上没有任何地方需要它。

- [ ] **Step 1: 先 grep 确认零引用**

Run: `grep -rn "limitCharsFor" src/ tests/`
Expected: 只剩 `transcript-renderer.ts` 的定义行与测试里的调用/import。
**若发现第 4 处引用，停下来报告，不要自行决定。**

- [ ] **Step 2: 删函数**

删除 `src/background/transcript-renderer.ts` 里 `limitCharsFor` 的整个定义
（含其上方的 `stage-a/dead-branch` 注释块——注释是描述这个函数的，随函数一起删）。
确认该文件其余导出（`renderTranscript` / `renderTail`）不受影响。

- [ ] **Step 3: 删对应测试块**

删除 `tests/unit/transcript-renderer.test.ts` 里 Step-1 阶段新增的
`describe('limitCharsFor', ...)` 整块，以及 import 语句里的 `limitCharsFor`。
**该文件其他用例一个都不许动。**

- [ ] **Step 4: 验证零残留**

Run: `grep -rn "limitCharsFor" src/ tests/`
Expected: 无任何输出。

- [ ] **Step 5: 跑全量 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 547 − 1 = 546 passed，tsc 0 错误。测试数减少 1 是预期的（删了一个用例）。

- [ ] **Step 6: 提交**

```bash
git add src/background/transcript-renderer.ts tests/unit/transcript-renderer.test.ts
git commit -m "refactor(transcript): 删除无人调用的 limitCharsFor 及其测试"
```

---

## 完成判据

- [ ] `bun run test` 全绿（546），`tsc --noEmit` 0 错误
- [ ] `grep -rn "limitCharsFor" src/ tests/` 无输出
- [ ] `grep -rn "from '\.\./content/" src/background/` 无跨界 import
- [ ] `grep -rn "from '.*models-sync'" src/background/` 确认合理
- [ ] 全量 diff 中无任何 `expect` 期望值/结构改动
- [ ] `scripts/merge.sh` 退出码 0
