# 阶段 A · Provider 抽象去 DeepSeek 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让共享层不再携带 DeepSeek 专属假设，为第二个 provider（ChatGPT）铺路，且**对外行为逐字节不变**。

**Architecture:** 三处泄漏分别下沉：`router.ts` 越过 provider 边界直接 import DeepSeek 的 DSML 归一化器；`adapter.ts` 共享接口里塞着 DeepSeek 的 wire 词汇与已失效字段；`transcript-renderer.ts` 有一条永不触发的死分支。每一处都改为「DeepSeek 自己拥有、共享层不提及」。

**Tech Stack:** TypeScript 5.9、vitest 2.1、esbuild、MV3 Chrome 扩展、bun（依赖管理）

**Spec:** `docs/superpowers/specs/2026-10-01-chatgpt-page-bridge-design.md`（§4 架构泄漏表、§4.1 实施拆分）

## Global Constraints

- **验收基线：`bun run test` 现有 535 个测试全绿，且不得修改任何现有断言。** 这是本阶段唯一的正确性判据——重构必须外部行为不变。
- 提交走 `scripts/merge.sh`（worktree 内发起），不手敲 rebase/merge/push。
- 每个方法不超过 50 行；每个 magic number 注释说明为什么是该值。
- 新增/修改代码注释用中文，解释「为什么」而非「做了什么」。
- 工作目录必须在 `~/me/code/deep-api-<branch>` worktree 内，禁止改主目录文件。
- 阶段 A **不得引入任何新依赖**。

## 本阶段明确不做（连同理由）

以下三项看似属于「架构泄漏清理」，但**推迟到阶段 B**，因为 AGENTS.md 明令
「只有一个实现的 interface 没有意义——第二个真实实现出现时再提取抽象」：

| 项 | 推迟理由 |
|---|---|
| `registry.ts` 改真多 provider | `createRegistry` 收 3 行即可，但 router 已在 `Object.values(registry)` 上泛化遍历，改了也只有一个 provider 在用。阶段 B 出现 ChatGPT adapter 时它自然变成真需求。 |
| `sw.ts` 15 处 `'deepseek'` 硬编码参数化 | 同上。现在抽「每 provider 配置槽」是纯投机抽象。 |
| `content/models-sync.ts` 被 router import | 是 label 抓取脚本进 background 的依赖方向问题，与本阶段三项无耦合，单独处理。 |

## Review Focus

以下五类是 spec 暗示、但现有测试未覆盖、且最可能咬人的输入。每条都在下方
对应任务里有钉住它的测试。

1. **不带 `normalizeContent` 的 adapter**（即将来的 ChatGPT）——带 tools 时 `content_delta` 必须**原样透传**，绝不能被 DSML 解析器吃掉。
2. **`toolCtx.promptSuffix === ''`（无 tools）**——不应创建归一化器，创建了也必须是无害的 no-op。
3. **归一化器 `unparsed` / `dropped` 为空数组**——`repairToolCalls` 的入参行为必须与重构前逐字节一致（空块 repair 路径，v0.2.6 的血泪）。
4. **老持久化 thread（无 `variant` 字段）**——model-switch 比对必须走「不约束」路径，不能因字段改名而对所有存量 thread 误判 rebuild。
5. **`deepseek-v4-flash` ↔ `deepseek-flash` 互切**（两者 `variant` 相同）——仍走 incremental，**不**触发 rebuild（这是刻意设计，别"顺手修正"）。

---

### Task 1: DSML 归一化下沉到 DeepSeek adapter

**Files:**
- Modify: `src/background/providers/adapter.ts`（新增 `ContentNormalizer` 接口 + `ProviderAdapter.normalizeContent?`）
- Modify: `src/background/providers/deepseek/adapter.ts`（实现 `normalizeContent`）
- Modify: `src/background/router.ts:12`（删 import）、`router.ts:727`（改调用）
- Test: `tests/unit/adapter-normalizer.test.ts`（新建）

**Interfaces:**
- Consumes: `createDsmlStreamNormalizer(tools: ToolDef[] = []): DsmlStreamNormalizer`（`src/background/providers/deepseek/dsml-parser.ts:185`，已存在，不改）
- Produces:
  ```ts
  // src/background/providers/adapter.ts
  export interface ContentNormalizer {
    feed(delta: string): string;
    flush(): string;
    readonly unparsed: string[];
    readonly dropped: string[];
  }
  // ProviderAdapter 上新增可选方法
  normalizeContent?(tools: ToolDef[]): ContentNormalizer | null;
  ```
  注意 `DsmlStreamNormalizer` 的 `unparsed`/`dropped` 是**可变数组属性**，不是只读字段；`ContentNormalizer` 声明为 `readonly` 是为了让其他 provider 无法改写它们。

- [ ] **Step 1: 写失败测试① —— 无 `normalizeContent` 的 adapter 必须原样透传**

在 `tests/unit/adapter-normalizer.test.ts` 新建。构造一个最小 `ProviderAdapter`（用 `as unknown as ProviderAdapter` 转型，字段填最少），其 `content_delta` 序列里含 `｜DSML｜tool_calls` 字面量；**不实现** `normalizeContent`。断言：经 `router.create({stream:true})` 产出的分块里，该字面量**原样出现**（当前代码会因全局 DSML 归一化被吃掉，此测试当前应失败）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run tests/unit/adapter-normalizer.test.ts`
Expected: FAIL —— 断言「字面量原样出现」不成立，实际被归一化器改写。

- [ ] **Step 3: 写失败测试② —— 无 tools 时不得创建归一化器（Review Focus #2）**

同文件加一例：`toolCtx.promptSuffix === ''`（请求不带 tools）时，router 不得调用
`normalizeContent`。做法：给 stub adapter 的 `normalizeContent` 挂一个计数器，
请求不带 `tools` 跑一轮，断言计数器为 0；再带 tools 跑一轮，断言计数器为 1。

- [ ] **Step 4: 写护栏测试③ —— unparsed/dropped 为空时 repair 入参不变（Review Focus #3）**

同文件加一例：构造 DeepSeek adapter，让 DSML 归一化器正常解析出一个**合法**工具块，
断言 `repairToolCalls` 拿到的 `unparsed` / `dropped` 均为空数组 —— 即成功路径不触发 repair。
这条锁定「空块 repair」（v0.2.6）路径在重构后行为不变。

- [ ] **Step 5: 写护栏测试④ —— DeepSeek adapter 仍要归一化（当前应通过）**

同文件加一例：真实 `createDeepSeekAdapter`，同样的 DSML 输入，断言下游收到的是标准 `<tool_calls>` JSON。**此测试当前应通过**（行为未变），它的作用是锁住重构不改变 DeepSeek 行为——即「阶段 A 不改对外行为」的机器可验证表达。

- [ ] **Step 6: 在 `adapter.ts` 加 `ContentNormalizer` 与可选方法**

在 `ProviderCompletion` 定义之前插入 `ContentNormalizer` 接口（成员照抄 `DsmlStreamNormalizer` 的公开面，去掉注释）。在 `ProviderAdapter` 里 `continueStream?` 之后新增：

```ts
  /** 2026-10-01（stage-a/decouple-dsml）：本 provider 的流式 content 是否需要归一化。
   *  DeepSeek V4 的原生工具协议是 DSML，spice 按标准 <tool_calls> 解析不了，必须重写；
   *  其他 provider 的 content 原样透传。不实现此方法 = 原样透传。 */
  normalizeContent?(tools: ToolDef[]): ContentNormalizer | null;
```

- [ ] **Step 7: 在 DeepSeek adapter 实现它**

`src/background/providers/deepseek/adapter.ts` 的返回对象里，`capabilities` 之前加：

```ts
    normalizeContent: (tools) => createDsmlStreamNormalizer(tools),
```

并加 import `import { createDsmlStreamNormalizer } from './dsml-parser';`（同目录相对路径）。

- [ ] **Step 8: 改 router 走 adapter**

`src/background/router.ts`：
- 删掉第 12 行 `import { createDsmlStreamNormalizer } from './providers/deepseek/dsml-parser';`
- 第 727 行改为：

```ts
        const dsml = toolCtx.promptSuffix !== '' ? (provider.normalizeContent?.(toolCtx.tools) ?? null) : null;
```

`provider` 已是 `encodeStream` 的首参，在作用域内。

- [ ] **Step 9: 跑测试确认四个用例都通过**

Run: `bunx vitest run tests/unit/adapter-normalizer.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 10: 跑全量确认无回归**

Run: `bun run test`
Expected: 535 + 4 = 539 passed，无失败。**若有用例失败，说明本任务改变了 DeepSeek 行为 —— 停下来查，不要改断言。**

- [ ] **Step 11: 提交**

```bash
git add src/background/providers/adapter.ts src/background/providers/deepseek/adapter.ts src/background/router.ts tests/unit/adapter-normalizer.test.ts
git commit -m "refactor(router): DSML 归一化下沉到 adapter，router 不再 import deepseek 目录"
```

---

### Task 2: 清理共享接口里的死字段

**Files:**
- Modify: `src/background/providers/adapter.ts:47-48`（删 `cookieDomain` / `requiredCookies`）、`:68`（删 `capabilities`）
- Modify: `src/background/providers/deepseek/adapter.ts:196`（删 `capabilities` 行）
- Test: `tests/unit/adapter-dead-fields.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `ProviderAdapter.auth` 只剩 `loginPageUrl` + `getAuthStatus()`；`ProviderAdapter` 不再有 `capabilities`。

删除依据（已核实，勿重新论证）：
- `capabilities` 全仓**只有声明处与 DeepSeek 的赋值处，没有任何读取点**。
- `auth.cookieDomain` / `auth.requiredCookies` 从未被读取；`src/background/providers/deepseek/auth.ts` 里另有 `DEEPSEEK_COOKIE_NAMES` 常量，但那与 `ProviderAdapter` 上的字段无关（且按项目 memory，DeepSeek auth 早已改 localStorage JWT，cookie 路径本就是历史遗留）。

- [ ] **Step 1: 写测试证明这些字段无人依赖**

`tests/unit/adapter-dead-fields.test.ts`：断言 `'capabilities' in adapterDescriptorOfCreateDeepSeekAdapter() === false`、同理 `cookieDomain` / `requiredCookies`。做法：对 `createDeepSeekAdapter(deps)` 的返回对象做 `expect(Object.keys(a)).not.toContain('capabilities')`，并对 `a.auth` 同样断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run tests/unit/adapter-dead-fields.test.ts`
Expected: FAIL —— 三个字段当前都还在。

- [ ] **Step 3: 删掉三处声明与一处赋值**

- `adapter.ts:47-48`：删除 `readonly cookieDomain: string;` 与 `readonly requiredCookies: string[];` 两行
- `adapter.ts:68`：删除 `capabilities: { thinking: boolean; functionCalling: 'none' | 'prompt-engineered' };` 整行
- `deepseek/adapter.ts:196`：删除 `capabilities: { thinking: true, functionCalling: 'prompt-engineered' },` 整行

- [ ] **Step 4: 跑测试确认通过**

Run: `bunx vitest run tests/unit/adapter-dead-fields.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全量 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 539 passed，tsc 0 错误。tsc 报错说明有隐藏读取点，顺着报错找到并判断是真依赖（则**回滚本任务**并写进 spec）还是漏删。

- [ ] **Step 6: 提交**

```bash
git add src/background/providers/adapter.ts src/background/providers/deepseek/adapter.ts tests/unit/adapter-dead-fields.test.ts
git commit -m "refactor(adapter): 删除无人读取的 capabilities 与失效 cookie 字段"
```

---

### Task 3: 删除 transcript-renderer 的 `'expert'` 死分支

**Files:**
- Modify: `src/background/transcript-renderer.ts:4-6`
- Test: `tests/unit/transcript-renderer.test.ts`（追加 1 例）

**Interfaces:**
- Consumes: 无
- Produces: `limitCharsFor` 签名与返回类型**不变**，只是不再有永不成立的分支。

背景（已核实，勿重新论证）：`limitCharsFor(modelType: 'default' | 'expert')` 的实现是
`modelType === 'expert' ? 163_840 : 2_621_440`。但 `deepseek/client.ts` 的 `LIMITS`
只产出 `'default'` 与 `'vision'`，**没有任何模型产出 `'expert'`**（`deepseek-v4-pro` 已
retired）。该分支自 v0.1.35 起从未被走到，是死代码。

- [ ] **Step 1: 写失败测试 —— `limitCharsFor` 对任何输入都返回上限**

在 `tests/unit/transcript-renderer.test.ts` 追加一例：对 `'default'`、`'expert'`、
`'vision'`、任意字符串四个输入，断言 `limitCharsFor` 一律返回 `2_621_440`。
**当前应失败**（`'expert'` 那一例会返回 163_840）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bunx vitest run tests/unit/transcript-renderer.test.ts`
Expected: FAIL —— `'expert'` 用例实际返回 163_840。

- [ ] **Step 3: 删掉死分支**

`src/background/transcript-renderer.ts:4-6` 改为：

```ts
// 2026-10-01（stage-a/dead-branch）：原实现是 `modelType === 'expert' ? 163_840 : 2_621_440`，
// 但 LIMITS 里没有任何模型产出 'expert'（deepseek-v4-pro 已 retired），该分支从未被走到。
// 形参与返回签名保持不变（router.ts 依赖），只去掉永不成立的分支。
export function limitCharsFor(_variant: string): number {
  return 2_621_440;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bunx vitest run tests/unit/transcript-renderer.test.ts`
Expected: PASS（含新增用例）

- [ ] **Step 5: 跑全量 + 类型检查**

Run: `bun run test && bunx tsc --noEmit`
Expected: 540 passed，tsc 0 错误。若有用例失败，说明真有代码在传 `'expert'`——
**停下来查，不要改断言**。

- [ ] **Step 6: 提交**

```bash
git add src/background/transcript-renderer.ts tests/unit/transcript-renderer.test.ts
git commit -m "refactor(transcript): 删除无人走到的 'expert' 分支"
```

---

## 已从本阶段移出的项（见 ledger Ruling 2）

`modelType` → 中性 `variant` 的重命名**推迟到阶段 B**。原因：该字段在 10 个测试文件共
62 处（`deepseek-client` 19 / `router-vision` 8 / `router` 5 / `deepseek-adapter` 3 /
`deepseek-models` 3 / `session-mapper` 11 / 其他 5，含 `tests/replay/trajectory-replay.test.ts`），
重命名必然要求修改大量现有断言，与本阶段「不得修改任何现有断言」的全局约束直接冲突；
且它不影响任何功能。阶段 B 出现 ChatGPT adapter 后 `variant` 才有真实语义，届时重命名
才有回报。

**本阶段仍不碰 `ThreadEntry.modelType` 这个 chrome.storage 持久化键**（同 Ruling 2 的理由）。

## 完成判据

- [ ] `bun run test` 全绿，且**没有修改任何现有测试断言**（新增用例除外）
- [ ] `bunx tsc --noEmit` 0 错误
- [ ] `grep -rn "deepseek" src/background/router.ts` 无 import 行（`createDsmlStreamNormalizer` 已下沉）
- [ ] `grep -n "'expert'" src/` 无结果
- [ ] `scripts/merge.sh` 退出码 0，`origin/main` 已更新
- [ ] 阶段 B（ChatGPT provider）可以在这块地基上开工
