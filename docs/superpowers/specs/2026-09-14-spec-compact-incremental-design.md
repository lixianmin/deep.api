# 2026-09-14 incremental 轮工具 spec 精简（spec-compact-incremental）

## 背景

每轮请求的 promptSuffix 拼「格式规范 + 完整工具定义（含每个工具的完整参数 JSON Schema）+ 调用指令」，实测约 4,574 字符 ≈ 1.3K tokens/轮（用户侧实测）。

**为什么这是浪费**：DeepSeek 网页 API 是**有状态线程**（历史上下文由 `parent_message_id` 链维护，`transcript-renderer.ts` 注释明示）。rebuild 首轮的全量 spec 已经随转录写入线程；`router.ts` 的 `runCompletion` 4 个 prompt 拼接点（初始 rebuild / 初始 incremental / afterLock 重决策 incremental / 重决策 rebuild）却每轮把同一份全量 spec 再追加一遍。30 轮任务线程里积约 40K tokens 的样板副本——纯占位不说，还稀释模型对首轮 spec 的注意力。

**结论（已确认）**：短会话（1–10 轮）可接受不改；本 spec 只处理长会话的增量轮。决策已拍板：纯 compact + 自愈；全模式（auto / required / named）一律走 compact。

## 修法

### 1. `tool-pipeline.ts`：双后缀 + 指纹 helper

`ToolContext` 变为：

```ts
export interface ToolContext { promptSuffix: string; compactSuffix: string; tools: ToolDef[] }
```

- `promptSuffix`：全量 spec，文案与语义不变（**非空 = 工具激活**，router `finalize`/`encodeStream` 的 `promptSuffix !== ''` 判据继续成立；无工具/`none` 时与 `compactSuffix` 同为 `''`）。
- `compactSuffix`（约 300–450 字符，随工具数量浮动）：

```
### 工具调用提醒
工具集与本会话前文一致（完整参数 Schema 见前文，不重复）。可用工具：{name 列表一行}
调用格式不变：<tool_calls> 内输出 JSON 数组，每元素形如 {"id":"<id>","type":"function","function":{"name":"<name>","arguments":"<args-json-string>"}}，arguments 必须是 JSON 字符串（外层先 stringify）。
{逐模式约束行}
```

  逐模式约束行（**保住 09-12 instruction 硬化**，语义等价）：
  - `auto`：`不携带工具块的纯文本只允许两种：最终总结，或向用户提问。`
  - `required`：`必须调用至少一个工具；不允许只给出纯文本回答。`
  - 指定单工具：`仅可调用工具 {name}。`

- `toolSpecFingerprint(tools)`：**指纹一律基于 `toolCtx.tools`**（buildToolPrompt 归一化后的集合，非调用方原始 `p.tools`——`none`/空集时被强制为 `[]`，指纹自动落 `''`，与「双 suffix 皆空」一致，避免「传了 tools 但 choice=none」时出现非空指纹的神秘不一致）。无工具 → `''`（稳定常量，表示「线程无 spec 需求」）；否则按 `function.name` 排序后 `JSON.stringify` 的 FNV-1a 64-bit（顺序不敏感；算法沿用 `session-mapper.ts` 已有 `fnv1a64` 思路，tool-pipeline 内置小实现，不反向依赖）。

### 2. `router.ts`：按行动选变体 + specMode 诊断

4 个拼接点改为 `renderXxx(...) + pickSuffix(thread, toolCtx)`：

- rebuild（初始 / 重决策）→ `promptSuffix`（全量，现状不变）。
- incremental（初始 / 重决策）→ `thread.toolSpecFingerprint === toolSpecFingerprint(tools)` ? `compactSuffix` : `promptSuffix`（全量）。
  - 重决策路径按**重决策后的**线程与行动再选一次（并发推进后指纹可能已被对方 commit 更新，重新比较是正确行为）。
- `RunState` 加 `specMode: 'full' | 'compact'`，进 `requestFull` 诊断（验证优化生效 + 漂移事件可按 specMode 关联）。**时序注意**：`run` 对象在 prompt 构建之后才创建（runCompletion 现有结构），故拼接点先用局部变量 `let specMode: 'full'|'compact' = 'full'` 记录，`run` 初始化时带入；afterLock 重决策处同步 `handle.run.specMode = ...`。

### 3. `session-mapper.ts`：指纹存储，唯一写入点 = commit

- `ThreadEntry` 加 `toolSpecFingerprint?: string`。
- `commit()` 增可选参数 `toolSpecFingerprint`；`register()` 同（commit 的「线程缺失→register」兜底路径转发）。
- **写入时机 = commit 唯一写点**（见评审修复 R2）：`register` 与「incremental 全量轮预锁拼 prompt」都不写。
- `restore()` 对旧持久化（无该字段 → `undefined`）兼容：首轮按「不匹配」走全量，commit 后回补——与 `modelType` 的 undefined 兼容模式同一策略。

**档板原则**：宁可多送一轮全量（不确定时），绝不在「全量 spec 未确认落线」时发 compact——compact 的隐含前提是「前文已有同工具集全量 spec」。

## 边界条件表（每条来自评审）

| # | 场景 | 行为 |
|---|------|------|
| 1 | 首轮 rebuild（带工具） | 全量；commit 后写指纹 |
| 2 | 同 cid 同工具 incremental | 指纹匹配 → compact |
| 3 | 工具集变化（含仅顺序变化） | 指纹不匹配 → 全量 → commit 更新指纹 |
| 4 | 首轮 tools=[]，后续带工具 | fp(`''`)≠fp(tools) → 全量（线程从未含 spec） |
| 5 | SW 重启（restore） | 字段随 serialize/restore 保留；缺失 → 首轮全量回补 |
| 6 | 队列超时（incremental 全量轮未发出） | 指纹未写（commit 唯一写点）→ 下轮仍全量，无错误 compact |
| 7 | 格式漂移（compact 轮模型忘 spec） | 既有 repair → 仍失败 400 → `mapper.fail` 销毁线程 → 下轮 rebuild 全量（自愈闭环，不加计数器） |
| 8 | tool_choice 变化（同工具集） | 指纹只看工具集 → 匹配 → compact 携带新的逐模式约束行 |
| 9 | tool_choice=none | 双 suffix 皆空 → 不追加 |
| 10 | vision / DSML 模型 | prompt 文本本就被模型忽视，DSML 归一化走 `toolCtx.tools`（schema 驱动），行为不变 |
| 11 | continue-on-incomplete 续接轮 | 只发 message_id + skip 计数，不带 prompt，不涉及 |
| 12 | repair 轮 | `REPAIR_INSTRUCTION` + raw，不带 suffix，不涉及 |
| 13 | 同 cid 并发排队 | 重决策按「新 tail + 当时指纹」再选变体（对方 commit 更新指纹后可能从全量降为 compact——此时线程确实已含新全量，正确） |
| 14 | limitChars 超限 | compact 缩短增量 prompt → 长会话更晚触限（正向副作用，不承诺） |

## 测试计划（TDD）

**fail-to-pass**：

`tests/unit/tool-pipeline.test.ts`
1. 全量：既有断言不动（`promptSuffix` 语义不变）。
2. `auto` compact：含「工具调用提醒」、格式一行（`arguments` 必须是 JSON 字符串）、可用工具名、「最终总结，或向用户提问」、`<tool_calls>`；**不含**「参数 JSON Schema」。
3. `required` compact 含「必须调用至少一个工具」；named compact 含「仅可调用工具」。
4. 无工具 / `none` → `compactSuffix` 为 `''`。
5. 指纹：同工具集不同顺序 → 相同；集合变化 → 不同；无工具 → `''`。

`tests/integration/router.test.ts`（harness `stubAdapter` 已把 `req.prompt` 捕获进 `a.prompts`，可直接断言出站 prompt）
6. round1 rebuild 出站 prompt 含「参数 JSON Schema」；round2 同 cid 同工具 incremental 出站 prompt **不含**「参数 JSON Schema」、含「工具调用提醒」。
7. round3 换工具集 → 出站 prompt 含「参数 JSON Schema」（指纹不匹配）；round4 同新工具 → compact。
8. afterLock 重决策（incremental→rebuild）→ 重建后的 prompt 含全量（变体跟随行动）。
9. `requestFull.specMode` 随轮次正确：rebuild='full'，同工具 incremental='compact'，换工具='full'。

**pass-to-pass**：

`tests/unit/session-mapper.test.ts`
10. commit 写入指纹；serialize→restore 保留；旧数据无字段 → `undefined`。

回归：既有 tool-pipeline / router / transcript-renderer / dsml-parser / session-mapper 全绿。

## 验收

- `bunx vitest run` 全绿。
- debug 日志可观测：incremental 轮 `requestFull.promptLen` 明显下降（全量 ≈4.5K 字符 → compact ≈0.3K），`specMode` 分布符合预期。
- 漂移率观察（上线后）：repair/400 计数不因本改动上升（现有 log 的 error/req 计数可对比）。

## 与 09-12 spec 的关系（对标声明，AGENTS.md §10.3）

- 09-12 spec 的「required 分支不动」指**约束文本不被弱化**；本改动只改变 incremental 轮的**轮询形态**（全量 → compact），约束行文本与语义逐字等价保留（见修法 §1），且在测试计划中断言锁定。无冲突。
- 09-12 spec 文件当前未提交（git untracked，上项工作遗留）——本 spec 不代管、不修改它。

## 明确不做

- 不加周期性全量刷新、不加漂移计数升级（用户已拍板：纯 compact + 自愈）。
- 不动 repair 路径、不动 continue-on-incomplete、不动 09-12 的指令语义（auto/required 约束行等价保留）。
- 不改 vision / DSML 行为。
- 不把指纹写入点移到 register / 预锁期（评审 R2 否决）。

## 评审修复记录（多轮自审，先写后修）

- **R1（措辞）**：初稿 compact 写「本会话首轮已给出」——在「mid-thread 因工具集变化补发全量」之后会撒谎（全量不在首轮）→ 改「本会话前文」。
- **R2（竞态，最重要）**：初稿指纹在 prompt 构建期写（register + incremental 全量轮预锁写）。若 incremental 全量轮队列超时（同 webSessionId 有在途轮），full spec 实际未发出，线程却标了「已含」→ 下轮错误发 compact → 模型从未见过新 Schema。改为 **commit 唯一写点**（本轮真正成功落线才标），方向保持「不确定就全量」。
- **R3（顺序敏感）**：指纹对工具数组顺序敏感会在 harness 顺序抖动时每轮误判全量 → 排序后哈希。
- **R4（硬化弱化）**：compact 若只留格式一行会弱化 09-12 的宣言约束 → 逐模式约束行显式保留并断言锁定。
- **R5（不可观测）**：无 specMode 则生产上无法确认优化是否生效、漂移是否与 compact 相关 → 加诊断字段。
- **R6（常量稳定）**：无工具指纹若为 `undefined` 会与「旧持久化缺失」混淆（都走全量，语义虽安全但不精确）→ 用 `''` 表示「线程无 spec 需求」。
- **R7（round 2 自审）**：指纹来源原本含糊（「tools」可能被读成调用方原始数组）→ 明确**基于 `toolCtx.tools`**（归一化后的集合），`none`/空集强制落 `''`，杜绝「choice=none 时非空指纹」的不一致。
- **R8（round 2 自审）**：`specMode` 直接写 `handle.run` 会在实现时踩时序坑（`run` 在 prompt 构建后才创建）→ 明确局部变量先行、重决策处同步更新的写法。
- **R9（round 2 自审）**：09-12 spec 有「required 分支不动」字面——不改动有冲突可能 → 新增「与 09-12 spec 的关系」章节逐字对标：约束语义等价保留、仅轮询形态变化，并声明 09-12 文件未提交、本 spec 不代管。