# Reasoning / Search 字段对齐 pi-ai SDK 形态

**日期**：2026-09-11
**状态**：草案，待 review
**触发**：spice 等第三方站点用 pi-ai SDK 接多家 provider 时，每个 provider 都要适配一套不同的开关字段——deep.api 当前 `thinking: boolean` + `reasoning_effort: string` 两字段表达一个概念，命名又是 snake_case，跟 pi-ai 的 `reasoning: ThinkingLevel` 不兼容，调用方需要造两份 options 对象。

---

## 1. 目标与边界

**In scope**：
- 公开 `window.deepApi.chat.completions.create()` 参数里 `thinking: bool | null` + `reasoning_effort: 'low'|'medium'|'high'|'max'` 两字段 → 合并为单字段 `reasoning: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`
- `search: boolean` 字段保留顶层平铺，契约落盘（v0.1.34 加进代码时未单独落 spec）
- 硬切（breaking change），不做 alias / 不做 deprecation 过渡
- 与 pi-ai `ModelThinkingLevel` 类型对齐（camelCase 习惯、单字段语义）
- bridge 类型签名、router overrides 构造、DeepSeek adapter `completionPayload` 实现、demo UI、测试用例

**Out of scope**（本次不做）：
- `samplingParams` / `providerOptions` / `extras` 透传容器——pi-ai 才有，deep.api 是浏览器 JS API 不需要 TS 泛型容器；真要加第二家 provider 时再抽
- 多模态 reasoning 控制（vision 模型没有 thinking level 切换）
- reasoning 内容响应字段 `delta.reasoning_content` 的处理——memory v0.1.35 实测 web 端点不返，按"可能没有 reasoning"写代码；本次只动请求体
- 官方 DeepSeek API（`api.deepseek.com`）的 `thinking: { type }` 嵌套对象透传——deep.api 当前只用 web 端点（`chat.deepseek.com/api/v0/chat/completion`），无需对齐

---

## 2. 背景与决策

### 2.1 pi-ai 的字段设计（事实）

源码：`@earendil-works/pi-ai/dist/types.d.ts`

```ts
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;

// 用户写代码时调用的接口（streamSimple / generateText）
export interface SimpleStreamOptions extends StreamOptions {
  toolChoice?: ToolChoice;
  reasoning?: ThinkingLevel;       // ← 统一顶层字段，camelCase，单字段
  thinkingBudgets?: ThinkingBudgets;
}

// provider 内部转换层（OpenAI-completions provider 用）
export interface OpenAICompletionsOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinkingBudgets?: ThinkingBudgets;
}
```

pi-ai 的转换规则（`@earendil-works/pi-ai/dist/api/openai-completions.js`，thinkingFormat dispatch）：
- `reasoning` 用户输入 → 按模型配置的 `thinkingFormat` 转换：
  - `"openai"` → `reasoning_effort` 顶层
  - `"deepseek"` → `reasoning_effort` 顶层 + `thinking: { type: "enabled" | "disabled" }`
  - `"together"` → `reasoning: { enabled: bool }` + `reasoning_effort`
  - `"xhigh"` 在 DeepSeek 不支持 → 映射为 `"high"`（与官方文档 medium/xhigh → high 对齐）
- "off" 状态由 `Model.thinkingLevelMap: { off: null }` 表达（字段不出现），用户调用时不显式传

### 2.2 OpenAI 官方 / DeepSeek 官方 / deep.api 字段对照

| 字段 | OpenAI 官方 | DeepSeek 官方 | pi-ai 用户面 | deep.api 现状 → 改后 |
|---|---|---|---|---|
| thinking 控制 | （绑定到 reasoning 模型） | `thinking: { type: "enabled" \| "disabled" }` | `reasoning: ThinkingLevel` | `thinking: bool` ❌ → `reasoning: ModelThinkingLevel` ✅ |
| 思考力度 | `reasoning_effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'` | `reasoning_effort: 'none'\|'low'\|'high'\|'max'` | 同字段 | `reasoning_effort: 'low'\|'medium'\|'high'\|'max'` ❌ → 合并入 `reasoning` ✅ |
| 联网搜索 | （无） | （无；模型自动判断） | （无） | `search: boolean`（deep.api 独家，保留 ✅） |
| 命名风格 | snake_case | snake_case | camelCase | snake_case → `reasoning` 单字段无歧义 |

### 2.3 为何硬切不 alias

- 当前 deep.api 唯一外部调用方是 spice（用户控），demo 页是内部 QA 工具，硬切破坏面 ≤ 2 处
- v0.x 阶段做对历史包袱最小；等真有第三方接入时再背负 deprecation 期成本
- 三套共存（`thinking` + `reasoning_effort` + `reasoning`）会让 spec 维护和测试矩阵都膨胀

---

## 3. 接口契约

### 3.1 新 `create()` 签名

```ts
window.deepApi.chat.completions.create({
  model: string,
  messages: Message[],
  stream?: boolean,
  tools?: ToolDef[],
  tool_choice?: ToolChoice,
  conversation_id?: string,
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  search?: boolean,
  temperature?: number,
  max_tokens?: number,
})
```

### 3.2 reasoning 字段语义

| 输入值 | 映射到 DeepSeek 请求体 | 说明 |
|---|---|---|
| `undefined`（不传） | 走 `model.thinking` 默认（当前 LIMITS 全为 `true`） | 调用方无意见，用模型配置 |
| `'off'` | **不发送** `thinking_enabled` 和 `reasoning_effort` 字段 | 与 pi-ai `thinkingLevelMap: {off: null}` 语义对齐：字段缺席表达"off" |
| `'minimal'` | `thinking_enabled: true`, `reasoning_effort: 'low'` | DeepSeek 不接受 `minimal`，映射为 `low` |
| `'low'` | `thinking_enabled: true`, `reasoning_effort: 'low'` | |
| `'medium'` | `thinking_enabled: true`, `reasoning_effort: 'high'` | DeepSeek 不接受 `medium`，映射为 `high` |
| `'high'` | `thinking_enabled: true`, `reasoning_effort: 'high'` | |
| `'xhigh'` | `thinking_enabled: true`, `reasoning_effort: 'high'` | DeepSeek 不接受 `xhigh`，映射为 `high` |
| `'max'` | `thinking_enabled: true`, `reasoning_effort: 'max'` | |

**退化说明**：网页 UI（`chat.deepseek.com`）只有"是否开启 Thinking"二态开关，没有 level 选择器（用户已确认）。所以在 web 端**所有非 `off` 值功能等价**——`thinking_enabled: true` + `reasoning_effort` 透传。level 值仍按上表透传，留作：① 调用方代码与 pi-ai 一致 ② 万一 web 端未来开始 honor level 字段。**不要在响应里期待 `delta.reasoning_content` 出现**——memory v0.1.35 实测 web 端点不返（用户更正 v0.1.35 的"no-op"措辞：thinking 开关在请求层真实生效，只是响应不拆 `reasoning_content` 单独通道）。

### 3.3 search 字段契约

```ts
search?: boolean
```

| 输入值 | 映射到 DeepSeek 请求体 |
|---|---|
| `undefined` | `search_enabled: false` |
| `false` | `search_enabled: false` |
| `true` | `search_enabled: true` |

**说明**：
- 仅此一项，无 level 概念（与 DeepSeek 网页 UI "联网搜索"开关二态对应）
- `search_enabled: true` 在 web 端**真实生效**（与 thinking 的"请求层生效 / 响应层无 reasoning_content 通道"不同）——SSE 流里会带搜索结果片段
- 默认 `false` 是 deep.api 端的保守选择（节省配额 + 调用方显式开启更安全）；官方 DeepSeek API 模型自动判断
- deep.api 独家字段；无对齐目标（pi-ai / OpenAI / DeepSeek 官方都没有同名顶层参数；pi-ai `samplingParams: { search: true }` 与 `search: true` 在调用方代码里无本质区别）

### 3.4 TypeScript 类型导出

```ts
// src/shared/api-types.ts 新增
export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

`CompletionOverrides` 改：
```ts
export interface CompletionOverrides {
  /** Pi-ai-aligned thinking control. undefined = use model default; 'off' = strip
   *  thinking_enabled/reasoning_effort from request; other levels collapse to
   *  thinking_enabled=true on the web endpoint. */
  reasoning?: ReasoningLevel;
  /** Web search toggle (deep.api-specific). */
  search?: boolean;
}
```

---

## 4. DeepSeek 请求体映射（adapter 实现要点）

`src/background/providers/deepseek/client.ts:completionPayload` 重写：

```ts
export function completionPayload(
  session: ProviderSession,
  prompt: string,
  model: { modelType: 'default' | 'expert' | 'vision'; thinking: boolean },
  overrides?: { reasoning?: ReasoningLevel; search?: boolean },
  refFileIds?: string[],
): Record<string, unknown> {
  const searchEnabled = overrides?.search === true;  // 默认 false
  const payload: Record<string, unknown> = {
    chat_session_id: session.webSessionId,
    parent_message_id: session.parentMessageId ?? null,
    model_type: model.modelType,
    prompt,
    ref_file_ids: refFileIds && refFileIds.length > 0 ? refFileIds : [],
    search_enabled: searchEnabled,
    action: null,
    preempt: false,
  };

  const r = overrides?.reasoning;
  if (r === 'off') {
    // 字段缺席，让服务端用自家默认（与 pi-ai thinkingLevelMap: {off: null} 对齐）
  } else if (r === undefined) {
    payload.thinking_enabled = model.thinking;  // 模型默认（当前所有模型为 true）
    payload.reasoning_effort = 'high';
  } else {
    payload.thinking_enabled = true;
    // level → reasoning_effort 映射（DeepSeek 不接受的别名折叠）
    payload.reasoning_effort =
      r === 'minimal' ? 'low' :
      r === 'medium' || r === 'xhigh' ? 'high' :
      r === 'max' ? 'max' :
      r;  // 'low' | 'high' 原样
  }
  return payload;
}
```

---

## 5. 桥接层改造点

### 5.1 `bridge-main.ts:207` create 类型签名

```ts
create: (params: {
  model: string;
  messages: Array<{ role: string; content: string; [k: string]: unknown }>;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  conversation_id?: string;
  reasoning?: ReasoningLevel;          // ← 替换 thinking + reasoning_effort
  search?: boolean;
}): Promise<ChatCompletion> | Response => { ... }
```

### 5.2 `router.ts:189-193` overrides 构造

```ts
const overrides = {
  reasoning: p.reasoning as ReasoningLevel | undefined,
  search: p.search as boolean | undefined,
};
```

### 5.3 demo tab（`src/debug/tabs/chat.ts`、`scenarios.ts`）

- 移除 `thinking` / `reasoning_effort` 两个 checkbox / select
- 替换为 `reasoning` 单 select（值：off / minimal / low / medium / high / xhigh / max）；UI 注释说明 web 端非 off 值功能等价
- `search` checkbox 保留

---

## 6. 迁移影响

### 6.1 调用方硬切

**spice 端**（仅外部调用方）：
- 旧：`{ thinking: true, reasoning_effort: 'high' }`
- 新：`{ reasoning: 'high' }`
- 调用方一次性修改，不做 alias

**demo 页 / scenarios tab**：同 §5.3。

**没有 deprecation 过渡期**——hard cut，spice 与 deep.api 同步升级。

### 6.2 测试矩阵更新

`tests/unit/deepseek-client.test.ts` 现有用例（基于 `thinking: bool/null` + `reasoning_effort` 两字段）全部改写为 `reasoning` 单字段：

| 旧测试 | 新测试 |
|---|---|
| defaults to thinking=true and reasoning_effort=high | reasoning=undefined → thinking_enabled=true, reasoning_effort=high |
| explicit true overrides default off | （删除：旧 thinking=true/false 三态不再存在） |
| explicit false overrides default on | reasoning='off' → thinking_enabled 字段缺席, reasoning_effort 字段缺席 |
| null thinking treated as explicit off | （合并到上面） |
| passes search_enabled=true | 保留（search 契约不变） |
| default reasoning_effort is high | 保留（默认 high 不变） |
| passes reasoning_effort override through | reasoning='low' → reasoning_effort='low'<br>reasoning='minimal' → reasoning_effort='low'<br>reasoning='medium' / 'xhigh' → reasoning_effort='high'<br>reasoning='max' → reasoning_effort='max' |
| preserves session/prompt fields | 保留 |

新增用例：
- `reasoning: undefined` 不带 overrides → 走 model.thinking 默认
- `reasoning: 'off'` → payload 不含 `thinking_enabled` 和 `reasoning_effort`
- `reasoning: 'off'` 时 `search_enabled` 仍按 caller 透传（互不干扰）
- bridge 类型签名拒绝非 `ReasoningLevel` 值（tsc 层面）

### 6.3 版本号

本次变更破坏公开契约 → minor bump：`0.1.107 → 0.2.0`。`bun run bump` 改 x.y.z 末位 +1 不足以表达破坏性，按 semver 走 minor bump——但项目用 x.y.z 三段且 bump 脚本只动末位，**脚本需先扩成支持 minor/major bump**，或本次手动改三处 version。

---

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| spice 升级不同步，调用旧字段拿不到 thinking 控制 | 升级前沟通；spice 是用户控，影响 ≤ 1 个外部调用方 |
| web 端 `thinking_enabled: false` 实际仍触发推理（v0.1.35 误判风险） | spec 已明确写"按可能没有 reasoning 写代码"；`reasoning: 'off'` 字段缺席而非 false，与 pi-ai `off: null` 一致，给服务端更大解释空间 |
| demo UI 加 level 选择器误导用户以为 level 真生效 | UI 注释：非 off 值在 web 端功能等价；memory v0.1.35 条目说明 web 端不返 reasoning_content |
| `completionPayload` 重写遗漏 `action: null` / `preempt: false` 等其他字段 | 测试覆盖 `preserves session/prompt fields`（保留） + 跑全量集成测试 |

---

## 8. 验收清单

- [ ] `tsc --noEmit` 0 错误（按 memory v0.1.83 教训）
- [ ] `bun run test` 全绿（包含新增 reasoning 映射测试 + search 回归测试）
- [ ] bridge 类型签名 `create` 拒绝 `thinking` / `reasoning_effort` 字段（tsc 层面验证）
- [ ] demo chat tab UI：移除旧 checkbox，新增 `reasoning` select
- [ ] demo scenarios tab 同上
- [ ] spice 同步升级到 `reasoning: 'high'` 形式（用户手测）
- [ ] version bump `0.1.107 → 0.2.0`
- [ ] `docs/01.memory.md` 修订 v0.1.35 条目措辞：thinking 字段在请求层真实生效，响应层不单独返 reasoning_content
- [ ] `bun run build` 产出 extension/ 时间戳更新
