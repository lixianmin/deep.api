# 阶段 A2 · 清 provider 抽象债 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在写 ChatGPT provider 之前，把共享层里最后两处「只有 DeepSeek 能用 / 只有 DeepSeek 用对」的假设清掉，使新增第二个 provider 不必回头改共享代码。

**Architecture:** 两笔独立机械改动——(1) `modelType` 改中性 `variant`；(2) `createRegistry` 收多 adapter 且会话清扫走全量。均为纯重构，**行为等价**。

**Tech Stack:** TypeScript 5.9、vitest 2.1、esbuild、bun

**Spec:** `docs/superpowers/specs/2026-10-01-chatgpt-page-bridge-design.md` §4 架构泄漏表第 1、3 行

## Global Constraints

- **`bun run test` 全绿（基线 549），`bunx tsc --noEmit` 0 错误。**
- **本阶段约束与阶段 A 不同**：阶段 A 禁止改任何现有断言；本阶段**必然要改断言**（字段改名就是目的）。约束改为：
  - 断言**语义**不得改变——只允许把标识符 `modelType` 机械替换为 `variant`，**任何期望值的字面量都不许调整**
  - 用例的增删除本任务明确要求的外不得进行
- 不得引入新依赖。注释用中文解释「为什么」；不留孤儿注释/导出。
- 提交信息首行不超过 72 字符。合并走 `scripts/merge.sh`。

## 本阶段明确不做（已与用户确认）

- **wire 字段 `model_type` 不变**——它是 DeepSeek 服务端的契约，只改我们内部的变量名。
- **登录态按 provider 存取**：已核实 `setAuthStatus(providerId, ...)` 本就按 `providers.${providerId}` 分键，**无需改动**。调用点传 `'deepseek'` 是 DeepSeek 自己的登录流程在调，是正确的。
- **工具调用栈保留**（`dsml-parser` / `tool-pipeline` / `chunk-encoder` 的 tool 分支）。用户已确认：网页版模型一律不做工具调用，DeepSeek 是唯一例外。
- **不为 ChatGPT 抽象 `sw.ts` 的 DeepSeek 特有逻辑**（token 同步 / `resyncAuth` 开标签页 / 配置项）——ChatGPT 一个都不需要，不造投机抽象。

## Review Focus

1. **`ThreadEntry.modelType` 键名必须保持不变**——它持久化在 `chrome.storage`，改名会让存量 thread 读不出该键，`decide()` 对 `undefined` 走「不约束」，**静默丢失 model-switch 检测能力**。
2. **DeepSeek 的 wire 字段 `model_type` 必须保持不变**。
3. **`deepseek-v4-flash` ↔ `deepseek-flash` 互切仍走 incremental**（两者 variant 相同）——刻意设计，别"顺手修正"。
4. **老持久化 thread（无该键）仍走「不约束」**，不得因改名对所有存量 thread 误判 rebuild。
5. **`/v1/models` 输出不变**——`variant` 不暴露给调用方。

---

### Task 1: `modelType` → 中性 `variant`

**Files:**
- Modify: `src/background/providers/adapter.ts`（新增 `ModelVariant` + 2 处改名）
- Modify: `src/background/session-mapper.ts`（9 处；**持久化键名不动**）
- Modify: `src/background/router.ts`（15 处）
- Modify: `src/background/providers/deepseek/client.ts`（7 处）
- Modify: `src/background/providers/deepseek/adapter.ts`（1 处）
- Modify: 10 个测试文件（62 处，见 Step 6）

**Interfaces — Produces:**
```ts
// src/background/providers/adapter.ts
/** provider 内部的「模型变体」标识。共享层不规定取值——各 adapter 自定义
 *  （DeepSeek 用 'default'/'vision' 这类 wire 词汇）。共享层只用它判断
 *  「同一 conversation_id 中途是否换了模型」，换了要 rebuild。 */
export type ModelVariant = string;

// ProviderCompletion
model: { variant: ModelVariant; thinking: boolean };

// ResolvedModel
export interface ResolvedModel { modelId: string; variant: ModelVariant; supportsImages: boolean; thinking: boolean; limitChars: number }
```

- [ ] **Step 1: 先加护栏测试，钉住最大风险点**

`tests/unit/session-mapper.test.ts` 追加两例（描述的是**当前**行为，重构不该让它们变红）：
- 构造不带 `modelType` 键的 `ThreadEntry`（模拟存量数据）→ `decide()` 不得返回 `rebuild`
- 同一 `conversation_id`，两次请求 variant 同为 `'default'` → 不得 `rebuild`

Run: `bunx vitest run tests/unit/session-mapper.test.ts`
Expected: **PASS**（它们是护栏，不是失败测试）

- [ ] **Step 2: 改共享类型 `adapter.ts`**

新增 `export type ModelVariant = string;`（注释见上）；`ProviderCompletion.model` 与
`ResolvedModel` 里的 `modelType: 'default'|'expert'|'vision'` → `variant: ModelVariant`。

- [ ] **Step 3: 改 `session-mapper.ts`（键名冻结）**

- **函数形参** `modelType?: 'default'|'expert'|'vision'` → `variant?: ModelVariant`（`decide`/`register`/`commit`）
- **`ThreadEntry` 属性名保持 `modelType`**，只改类型标注为 `ModelVariant`，并加注释说明
  **键名为什么冻结**（chrome.storage 持久化，改名会静默丢失 model-switch 检测）
- 比较逻辑改为「`t.modelType`（键）与形参 `variant` 比较」
- `register` 写入仍写 `modelType: variant`（键不变）
- `commit`：`if (variant !== undefined) t.modelType = variant;`

- [ ] **Step 4: 改 `router.ts`**

`resolved.modelType` → `resolved.variant`；`handle.run.model.modelType` → `.variant`。
**描述决策背景的历史注释保留**（记录的是背景，不随改名失效）；但**描述当前代码写法的注释要同步更新**。

- [ ] **Step 5: 改 DeepSeek 侧产出点**

- `client.ts`：`MergedModel.modelType` → `variant`；`LIMITS` 三条的 `modelType: 'X' as const` → `variant: 'X'`；
  `completionPayload` 形参 `{ modelType: ... }` → `{ variant: string }`
- **wire 字段名不变**：`model_type: model.variant`
- `deepseek/adapter.ts:170`：`{ modelType: req.model.modelType, ... }` → `{ variant: req.model.variant, ... }`

- [ ] **Step 6: 改测试（10 文件 62 处）**

只做标识符机械替换。**期望值字面量一个都不许动。**
用 `grep -c modelType <file>` 自核处数：`tests/unit/deepseek-client.test.ts` 19、
`tests/unit/session-mapper.test.ts` 11、`tests/integration/router-vision.test.ts` 8、
`tests/integration/router.test.ts` 5、`tests/unit/deepseek-adapter.test.ts` 4、
`tests/unit/deepseek-models.test.ts` 3、`tests/replay/trajectory-replay.test.ts` 1、
`tests/integration/router-review.test.ts` 1、`tests/integration/router-429-retry.test.ts` 1。

- [ ] **Step 7: 自证「期望值未被调整」**

Run: `git diff -- tests/ | grep -E '^[+-].*expect\('`
逐条核对：**每对 `expect` 行的期望值部分必须完全相同**，只有标识符变了。
若发现任何期望值字面量变化，**回滚该处并报告**。

- [ ] **Step 8: 跑全量 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 549 + 2 = 551 passed，tsc 0 错误

- [ ] **Step 9: 验证持久化键未变**

Run: `git diff -- src/background/session-mapper.ts | grep -E '^[+-].*modelType:'`
Expected: **无输出**——`register` 写入处的键名 `modelType:` 必须原样保留。

- [ ] **Step 10: 提交**

```bash
git add -A src/background/ tests/
git commit -m "refactor(model): 共享层 modelType 改中性 variant，DeepSeek wire 字段不变"
```

---

### Task 2: `createRegistry` 收多 adapter + 会话清扫走全量

**Files:**
- Modify: `src/background/providers/registry.ts`
- Modify: `src/background/session-mapper.ts`（`sweepAll` 改 public）
- Modify: `src/background/sw.ts:155`
- Test: `tests/unit/registry.test.ts`（新建）

**Interfaces — Produces:**
```ts
// src/background/providers/registry.ts
export function createRegistry(...providers: ProviderAdapter[]): Record<ProviderId, ProviderAdapter>;
```
重复 `id` 时**后者覆盖前者**（`Object.fromEntries` 语义），注释写明。

- [ ] **Step 1: 写失败测试 —— 收两个 adapter 都能被解析**

新建 `tests/unit/registry.test.ts`：构造两个 `id` 不同的最小 adapter（`as unknown as ProviderAdapter`
转型，字段填最少），断言 `createRegistry(a, b)` 结果同时含两个键。**当前应失败**（现签名只收一个）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run tests/unit/registry.test.ts`
Expected: FAIL —— 第二个 adapter 的键不存在

- [ ] **Step 3: 改 `createRegistry` 为变参**

```ts
export function createRegistry(...providers: ProviderAdapter[]): Record<ProviderId, ProviderAdapter> {
  // 重复 id 时后者覆盖前者（Object.fromEntries 语义）。当前只有一个 provider，
  // 做成变参是为了新增 provider 时不必回头改这里。
  return Object.fromEntries(providers.map((p) => [p.id, p]));
}
```

- [ ] **Step 4: 改会话清扫走全量**

`session-mapper.ts` 已有私有 `sweepAll()`（内部按 thread key 前缀收集所有 provider id 后逐个
`evictExpired`）。**改为 public**，并在 `sw.ts:155` 用它替换 `await mapper.evictExpired('deepseek');`。
**不要在 sw.ts 里重新实现一遍遍历。**

`sw.ts:239` 的 `createRegistry(adapter)` 签名兼容，**保持原样**——不要为了"统一"而改。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 551 + 1 = 552 passed，tsc 0 错误

- [ ] **Step 6: 提交**

```bash
git add src/background/providers/registry.ts src/background/session-mapper.ts src/background/sw.ts tests/unit/registry.test.ts
git commit -m "refactor(registry): createRegistry 收多 adapter，会话清扫走全量 provider"
```

---

## 完成判据

- [ ] `bun run test` 全绿（552），`tsc --noEmit` 0 错误
- [ ] `grep -rn "modelType" src/background/providers/adapter.ts` 无输出（共享层已无 DeepSeek 词汇）
- [ ] `git diff -- src/background/session-mapper.ts | grep -E '^[+-].*modelType:'` 无输出（持久化键未变）
- [ ] `grep -n "model_type" src/background/providers/deepseek/client.ts` —— wire 字段仍在
- [ ] `git diff -- tests/ | grep -E '^[+-].*expect\('` 逐条核对后确认无期望值调整
- [ ] `scripts/merge.sh` 退出码 0
