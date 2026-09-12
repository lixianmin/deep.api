# deep.api —— 把 DeepSeek 网页版转成 OpenAI 形态接口的 Chrome 扩展

日期：2026-09-08 · 状态：设计定稿待评审 · 版本：v1

## 1. 背景与目标

做一个 Chrome MV3 扩展，让任意网站的开发者以近似 OpenAI 的方式调用 DeepSeek（后续可扩展千问/Kimi/GLM 等网页版），**不需要任何伴生进程、不需要本地 HTTP 服务**：

- 网站页面通过扩展注入的桥接层 `window.deepApi` 直接与扩展通信（接受"小改造"：几行 snippet）。
- 扩展抓取 chat.deepseek.com 的登录 Cookie，直打 DeepSeek 网页版内部 API（`chat.deepseek.com/api/v0`），把 SSE 流式结果转成 OpenAI 形态的分块。
- 核心矛盾：网页端是有状态会话，Agent 假定 API 无状态。解法见 §4 SessionMapper：**客户端每次传来的 `messages` 是唯一事实，网页会话只是性能缓存**，任何历史漂移都自动重建会话，绝不串台。
- 架构上预留 Provider 适配层，v1 只实现 DeepSeekAdapter，后续接新 provider 只新增适配器。

## 2. 术语

| 词 | 含义 |
|---|---|
| 桥接层 | 注入网页的 `window.deepApi`，OpenAI 形态的调用面 |
| 核心层 | 与 provider 无关的逻辑（渲染、映射、工具管道、编码、池） |
| 适配器 | 一个网页版 provider 的具体实现（v1：DeepSeek） |
| 线程（thread） | 网页端的一个对话会话（DeepSeek 的 chat_session） |
| 镜像 | 核心层对某线程已确认消息序列的记录（用于增量判定） |

## 3. 总体架构

```
┌─ 网站页面 ──────────────────────────────────────┐
│ window.deepApi                                 │
│   chat.completions.create / models.list         │
├─ 桥接（内容脚本）────────────────────────────────┤
│ bridge-main.ts  (MAIN world：API 面)             │
│   ↕ window.postMessage（内部协议）                │
│ bridge-relay.ts (ISOLATED world：持久 port → SW) │
├─ Service Worker ───────────────────────────────┐
│ Router：API Key 校验 → 参数归一化 → 分发          │
│ SessionMapper：镜像/增量/重建/线程池/LRU/TTL      │
│ TranscriptRenderer：messages → 单轮转录          │
│ ToolPipeline：工具注入 + 解析 + 三层修复          │
│ ChunkEncoder：ProviderStreamEvent → OpenAI 分块  │
│ Queue：每 provider 队列 + 退避                    │
│ ProviderRegistry：providerId → Adapter           │
│   └── DeepSeekAdapter (v1)                       │
│   （Kimi/Qwen/GLM 适配器：接口预留，不实现）       │
└─────────────────────────────────────────────────┘
  ↕ chrome.runtime（port）
┌─ popup 面板 ────────────────────────────────────┐
│ 登录状态/登录入口 · API Key · 模型 · 池大小 · 日志 │
└─────────────────────────────────────────────────┘
```

设计原则：

- **核心层对所有 chrome.\* API 零依赖**（chrome 能力通过注入接口传入），保证可单测。
- **适配器面向 `AsyncIterable<ProviderStreamEvent>` 编程**，协议转换被关在适配器内部。
- 转录渲染、工具管道、分块编码、映射状态机与 provider 无关，只写一次。

## 4. 核心层

### 4.1 Router

请求处理管线（按序）：

1. 取 `apiKey`（from params.apiKey 或 `window.deepApiConfig`）→ 校验，失败 401。
2. 归一化请求：仅接受 `model`、`messages`、`stream`、`tools`、`tool_choice`、`conversation_id`，其余参数（temperature、max_tokens、user 等）忽略（OpenAI 兼容宽容，文档注明）；`apiKey` 按 §7 处理。
3. 按注册表精确匹配 model 解析 provider 与模型配置：遍历 provider 的 `models` 声明，命中即确定 provider；无命中 → 400 `invalid_request_error`（未知模型，附可用列表）。
4. 交给 SessionMapper 取/建线程并流式调用适配器；ChunkEncoder 编码；按 stream 聚合或推送。
5. 记录日志（时间、provider、model、状态、耗时、error；token 有则记）。

### 4.2 TranscriptRenderer（messages → 单轮 prompt）

- 输出为一条 user 风格 prompt，内部用网页原生角色标签区分（DeepSeek 采用 `<｜System｜>` / `user` / `assistant` 标签体系，格式对齐 ds-free-api 的 prompt.rs；**spike 用真实请求实测校准**）。
- 规则：合并连续同角色消息（防模型混淆）；system 折叠为首块；tool 消息渲染为工具结果文本块；结尾以最后一条 user 消息收束。
- 超限策略：按 ProviderModelConfig 的字符上限（DeepSeek：default 2,621,440 / expert 163,840，来自 ds-free-api 默认配置）校验；超限 → 400 `invalid_request_error`，message 说明"历史超长"并给出建议（滑动窗口/摘要留 v2）。
- 渲染是纯函数，输入 messages 数组与模型配置，输出字符串 —— 便于单测与夹具对照。

### 4.3 SessionMapper（状态矛盾解法，本设计核心）

每个 provider 一个映射表。线程状态：

```ts
interface ThreadState {
  key: string;               // 指纹：镜像前缀哈希（SHA-256 hex 前 32 位）
  webSessionId: string;      // 网页会话 id
  parentMessageId: number | null;  // 网页侧最后一条消息 id（新建后为 null）
  mirror: Message[];         // 已确认推进的消息序列（与网页线程内容一致）
  kind: 'auto' | 'named';    // conversation_id 显式创建
  idleSince: number;
}
```

请求 `messages = [m1..mn]`（n≥1，末尾为最新消息）到来时：

1. `prefix = [m1..m(n-1)]`；找一个 `kind='auto'` 且 `mirror` 是 `prefix` 前缀的线程作为候选（**镜像 ⊆ prefix 即命中**，允许 prefix 比镜像长——工具循环产生的 tool/function 消息自然成为"增量尾部"；多候选时取镜像最长者，保证确定性）。
2. **增量分支**：命中且 `tail = prefix - mirror` 非空且 `tail[0].role ∈ {'user', 'tool'}`（tool 为工具结果消息，渲染规则 §4.2/§4.4 已支持；assistant 头仍走重建）：
   - `prompt = renderTail(tail)`（尾部多轮带角色标记渲染）；
   - `parentMessageId = thread.parentMessageId`，同一线程继续。
3. **重建分支**（三者任一即触发）：
   - 无候选线程；
   - `tail[0].role !== 'user'`（如重放以 assistant 结尾的请求）；
   - `tail` 为空（**完整重放**：同一前缀同一末轮 —— 视为客户端重试，全新会话 + 全量转录重新回答，保持语义纯净）。
   - 动作：`adapter.createSession()` → `prompt = renderTranscript(M)` → `parentMessageId = null`。
4. 完成后：`mirror = M`（按请求的完整消息序列推进）、`parentMessageId = 响应消息 id`、`idleSince = now`。
5. 失败/中断：线程标记失败并销毁，不污染镜像。销毁是否真调 `deleteSession` 删除 DeepSeek 网页会话，由「自动删除网页 Chat Thread」设置（`autoDeleteWebThreads`，默认**关**）控制（2026-09-15 变更：关=只解除本地映射，网页会话保留）。

并发与资源：

- 每线程同一时刻最多 1 个在途请求；超出队列。
- 每 provider 线程池上限 `poolSize`（默认 2，面板可调 1–5）。队列等待上限 60s，超时 → 429 `rate_limited`（message 说明"忙于其他请求"）。
- 淘汰：`kind='auto'` 按 LRU；全部线程 TTL 空闲 30 分钟（面板可调）。淘汰时是否 best-effort `deleteSession` 由「自动删除网页 Chat Thread」设置控制：**默认关**——只解除本地映射，DeepSeek 网页侧会话保留（2026-09-15 用户拍板：网页 Chat Thread 被自动删除不符合预期，孤儿会话堆积是可接受代价）；开启后删除，保持网页侧干净。
- `conversation_id`（可选参数，默认关闭）：显式命名线程，客户端可省略历史但必须至少传最后一条 user 消息（省略全部 messages → 400 `invalid_request_error`，message 明确"无新消息"）；带消息且与镜像不符 → 在该命名线程内重建（旧会话弃用 → `createSession` → 全量转录，key 与 mirror 就地更新；旧会话是否真调 `deleteSession` 同样受「自动删除网页 Chat Thread」设置控制，默认关=网页旧会话保留）。命名线程只受 TTL 淘汰。

统计事实（来自 ds-free-api 源码，spike 复核）：DeepSeek 单会话串行产出、多会话并行可行但受限流控制；ds-free-api 建议并发 ≈ 账号数/2。因此默认池 2 是收敛值，日志面板可见未铺满时的排队情况。

### 4.4 ToolPipeline（prompt-engineered 工具调用）

内部接口不支持原生 function calling（ds-free-api 采取同款路线），v1 实现：

- **注入**：`tools` 非空且 `tool_choice !== 'none'` 时，向 prompt 追加三段（格式规范 / 工具定义 / 调用指令），用标签对包裹结果（识别 `tool_call_begin/end`、`tool_calls`、`tool_call` 三组标签，容错匹配，跳过代码块）。
- **解析**：取标签内 JSON 数组/对象 → 结构校验（名字、参数、id）。
- **DSML 归一化**（2026-09-10 补）：DeepSeek V4 的**原生**工具协议是 DSML（DeepSeek Markup Language）：`<｜DSML｜tool_calls>` 包裹、`<｜DSML｜invoke name="X">` 单调用、`<｜DSML｜parameter name="K" string="true|false">V</｜DSML｜parameter>` 参数（全角 ｜ U+FF5C、大写 DSML；`string="true"` 是字面字符串，`"false"` 按 JSON/schema 类型解释）。模型在长上下文下会从 prompt 教的 `<tool_calls>` 回退到它；网页 web API 无法禁用（官方服务端用 guided decoding 强制，网页端没这个钩子）。**实测（v0.1.97）模型吐的是混合形态**：开标签带命名空间、闭标签是普通 `</invoke>` / `</parameter>`，块闭标签还可能完全缺失——所以闭标签的命名空间必须可选，未闭合块也要在 flush 时归一化。**2026-09-10（v0.1.98）现场 `replySample` 进一步证实：命名空间可能被整体剥离**——收到的是裸 `<tool_calls>` + `<invoke name="X">` / `<parameter …>`（三个 invoke 依次读 sketch.ino / diagram.json / libraries.txt，同时 `reasoningSample` 正常）。此时三处正则全部落空 → `hasDsmlToolTags=false` → `hasToolTags=false` → router 判「模型没调工具」→ 原文当正文透传 + `finishReason=stop`、不 repair。所以**开标签的命名空间同样可选**，且 `hasDsmlToolTags` 不能只认块起始（裸 `<tool_calls>` 与正文里提到它无法区分）——改判「带命名空间的块起始」**或**「invoke/parameter 标记」。权威实现都把它当字面量写死（vLLM 正则、llama.cpp `build_grammar`），此处是**刻意的现场容错偏差**。

**2026-09-10（v0.1.102）base64 取证拿到字节级真身**：`LogEntry.rawB64`（归一化**前**的模型原文）解码后确认：命名空间**两侧各是 2 个全角竖线**（不是 1 个）、`DSML` 与标签名之间**多一个空格**、包裹名是 **`calls`（`tool_` 整段不在）**。v0.1.98/0.1.99 的容错全部落空，失败链路与上一段完全相同（静默 stop + 原文透传）。修法：竖线放宽为 `[|｜]+`、容忍其后空白、包裹名额外接受 `calls`；并把**检测判据刻意做得比解析判据宽**——`<` + 竖线+ + `DSML` + 竖线+ 即认定为工具标记，解析仍走严格正则，解析不出就 repair/400。根因判断：网页 API 没有 guided decoding（官方服务端有），模型是在自己学的分布上复现这个特殊标记，形态会**持续漂移**——所以不可能靠枚举形态收敛，只能「检测宽 + 失败响」。实现为 **vLLM `DeepSeekV32ToolParser`/`DeepSeekV4ToolParser` 的 TS 移植**（Apache-2.0，`src/background/providers/deepseek/dsml-parser.ts`）：非流式提取 + 流式归一化（块外逐段透传、只扣 `partial_tag_overlap` 的尾巴；块内缓冲到结束标记后**重写成标准 `<tool_calls>[…]</tool_calls>` 文本**）。**2026-09-15（v0.2.5，fix/dsml-close-tag-detect）第 5 形态**：spice 现场模型开**标准** `<tool_calls>`（prompt 教的形态）+ 块内合法 OpenAI JSON，收尾却幻觉出漂移形态的 DSML **闭标签**（`</｜｜DSML｜｜ parameter>` 等，`<` 与竖线之间有 `/`，与 v0.1.100 开标签漂移同形但在闭合位置）。检测正则只认开标签 → `hasToolTags=false` → 判「没调工具」→ 原文透传 + `stop`，使用方整轮停死。修法：**仅检测正则** `<` 放宽为 `</?`（解析仍严格）→ 落 repair/400 既有通路；「检测宽于解析」自此覆盖开/闭两种标签位置。
- **三层修复**：① 文本层（转义反斜杠、剥离围栏）② 结构层（补引号/去尾逗号）③ 模型兜底（对同一线程追加"请修复 JSON"重问 1 次，再失败 → 400 `tool_parse_error`）。
- **流式**：内容增量照常推送，但带 `tools` 时先过 DSML 归一化器（见上）——使用方收到的 content 里只有标准 `<tool_calls>` 文本，不会看到 DSML；工具调用在终止分块前以**完整 tool_calls 数组**发出（`finish_reason: 'tool_calls'`），不做参数增量流（v2 再考虑）。**归一化失败的块不得透传**（v0.1.98）：扣进 `unparsed`，流式路径按 `§4.4` 第 3 层 **repair 一次**（与非流式 `finalize()` 共用 `Router.repairToolCalls`），仍失败 → `invalid_request_error` 400（`sw.ts` 转 SSE error 帧 + `[DONE]`）。唯一例外：块无命名空间且块体无 invoke/parameter 标记 → 判为正文提到 `<tool_calls>`，原样透传（否则吞掉散文并误触发 repair）。
- 非流式：`message.tool_calls` 返回。
- `tool_choice: 'function'` → 指令限定调用该函数；`parallel_tool_calls` 忽略（文档注明）。
- 工具结果为 `role: 'tool'` 的消息在下一轮转录中作为工具结果文本块呈现。

### 4.5 ChunkEncoder

`ProviderStreamEvent` → OpenAI 分块。非流式聚合为单条 `ChatCompletion`。

```ts
// 分块样例（与 OpenAI chat.completion.chunk 一致，含 reasoning_content 扩展）
{ id, object: 'chat.completion.chunk', created, model,
  choices: [{ index: 0, delta: { role?: 'assistant', reasoning_content?, content?, tool_calls? },
              finish_reason: null | 'stop' | 'tool_calls' }] }
// 末尾补 usage 分块（有 accumulated_token_usage 时）
```

- `think_delta` → `delta.reasoning_content`（deepseek-reasoner 的思考过程）。
- `content_delta` → `delta.content`；`finish_reason` 透传。
- `usage` → 最终分块/非流式响应的 `usage`；**仅当 input 与 output 计数都可得时输出 usage**，只能得到部分计数时省略该字段（不编造计数）。
- 事件丢失/乱序防御：SSE 解析器状态机 + 兜底超时（本次请求 10 分钟无进度 → 断流，以 503 `provider_unavailable` 报错，附 message）。

## 5. ProviderAdapter 接口（契约，现在定死）

```ts
// 文件：src/background/providers/adapter.ts
interface ProviderAdapter {
  readonly id: ProviderId;              // 'deepseek' | ...（注册表枚举，v1 只注册 deepseek）

  auth: {
    readonly loginPageUrl: string;      // 面板"登录"打开的页面
    readonly cookieDomain: string;      // chrome.cookies 作用域
    readonly requiredCookies: string[]; // DeepSeek: ['user_token']（spike 实测核准）
    getAuthStatus(ctx: ProviderContext): Promise<AuthStatus>;   // 以 ctx.token 探测
    // AuthStatus = { state: 'logged_in' } | { state: 'logged_out' } | { state: 'expired', message }
  };

  createSession(ctx: ProviderContext): Promise<ProviderSession>;
  deleteSession(ctx: ProviderContext, s: ProviderSession): Promise<void>;
  stopStream(ctx: ProviderContext, s: ProviderSession, messageId: number | string | null): Promise<void>; // cancel 用，best-effort

  streamCompletion(ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent>;

  readonly models: ModelInfo[];                     // models.list 数据源（静态声明）
  resolveModel(modelId: string): ResolvedModel | null;  // OpenAI 模型名 → 内部模型配置

  isRateLimited(err: unknown): boolean;   // 映射为 429
  isAuthExpired(err: unknown): boolean;   // 映射为 503 + 面板提示重登
  isUnavailable(err: unknown): boolean;   // WAF/网络 → 503

  capabilities: { thinking: boolean; functionCalling: 'none' | 'prompt-engineered' };
}

interface ProviderSession  { providerId: ProviderId; webSessionId: string; parentMessageId: number | string | null; }
interface ProviderCompletion {
  session: ProviderSession;
  prompt: string;            // 核心层渲染好的完整转录或增量尾部（单轮）
  model: { modelType: 'default' | 'expert'; thinking: boolean };  // 已解析的模型配置（适配器据此组载荷）
  requestId: string;
}
type ProviderStreamEvent =
  | { kind: 'message_id'; id: number | string }   // 本轮响应消息 id（ready 事件），先于内容增量发出；父链更新的依据
  | { kind: 'think_delta';  content: string }
  | { kind: 'content_delta'; content: string; finish_reason?: 'stop' | string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

ProviderContext = { token: string; requestId: string }（适配器使用凭证与诊断信息；不持状态）
```

- 会话生命周期完全由核心层驱动（创建/删除/复用），适配器不持有自己的映射。
- 后续 provider（Kimi/Qwen/GLM）只需实现上述接口 + 各自的 auth 声明；核心层、桥接层、面板零改动（面板按注册表动态渲染）。
- 适配器内部自理：各家 PoW/反爬、SSE 协议 → 事件、模型名映射、限流语义。

### 5.1 契约测试

每个适配器必须通过 fixture 驱动的契约测试：

- `契约 1`：auth 状态判定（cookie 缺失/过期/有效）。
- `契约 2`：createSession 载荷与错误。
- `契约 3`：completion 全流程（请求头、PoW 头、载荷、SSE → 事件序列、finish_reason、usage）。
- `契约 4`：限流/失效/WAF 错误 → isRateLimited/isAuthExpired/isUnavailable 判定。

fixture 文件：`tests/fixtures/deepseek/*.json`（spike 录制，token 脱敏）。新 provider 加适配器时新增 fixture 目录，测试矩阵自动扩展。

## 6. DeepSeekAdapter（v1 实现细则）

### 6.1 端点与认证

- Base：`https://chat.deepseek.com/api/v0`（ds-free-api 默认值）。
- 头部：`Authorization: Bearer <user_token>`、`X-Client-Version: 2.0.0`、`X-Client-Platform: android`、`X-Client-Locale: zh_CN`、浏览器 UA。起始值取自 ds-free-api 已验证配置；**spike 用浏览器网络栈实测校准**（若 WAF/校验拒绝则调整组合）。
- 登录态：`chrome.cookies.get({ url: 'https://chat.deepseek.com', name: 'user_token' })`（cookie 名 spike 实测核准）；`chrome.cookies.onChanged` 监听提前感知失效。
- Auth 探测（getAuthStatus）：`create_session` → `delete_session` 即回；401/业务码 → expired。

### 6.2 PoW（每次 completion 必带）

1. `POST /chat/create_pow_challenge`，body `{ target_path: '/api/v0/chat/completion' }` → ChallengeData `{ algorithm, challenge, difficulty, target_path, salt, expire_at }`。
2. 求解：fetch `https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`（版本号会变动：版本失效（404/WASM 校验失败）→ 503 `provider_unavailable`，message 提示联系维护者更新扩展；不做运行时页面解析探测，探测逻辑留 v2）。`WebAssembly.instantiate`，调 `wasm_solve(retptr, challengePtr, len, prefixPtr, len, difficulty)`，其中 `prefix = salt + '_' + expire_at + '_'`；导出符号按签名探测（`__wbindgen_add_to_stack_pointer`、`__wbindgen_malloc`/`__wbindgen_export_*`、`wasm_solve`、memory）。
3. 结果 JSON `{ algorithm, challenge, salt, answer, signature, target_path }` → **base64** → 放 `X-Ds-Pow-Response` 头。
4. wasm 实例缓存（SW 内存），避免每次编译；求解失败 → 503 `provider_unavailable`。

### 6.3 Completion 载荷

```
POST /chat/completion
{ chat_session_id, parent_message_id: number|null, model_type, prompt: string,
  ref_file_ids: [], thinking_enabled: bool, search_enabled: false, preempt: false }
```

- `model_type` 映射：`deepseek-chat` → `default`、`deepseek-reasoner` → `expert`（ds-free-api 默认表 `["default","expert","vision"]`，spike 复核）；`vision` v1 不接入。
- `thinking_enabled`：reasoner 为 true（同时 `capabilities.thinking` 声明），chat 为 false。
- 响应为 SSE 事件流：先到 **ready 事件**（含 `request_message_id`/`response_message_id`，i64，源码 parse_ready_message_ids 核实）→ 适配器据此发 `message_id` 事件；其后 payload 是 **JSON-Patch 协议**：`response/status`、`response/fragments`（APPEND）、`response/fragments/-1/content`、`response/accumulated_token_usage`；fragment 类型 think/response。解析器状态机对齐前端 DeltaParser（路径 + op 应用，增量内容按片段类型分发）。
- 完成：`finish_reason` 以内容增量事件携带（`stop`；tool_calls 由核心层产生）。

### 6.4 会话与限制

- `chat_session/create`（创建）、`chat_session/delete`（删除）。
- 限流判定：HTTP 202 + `x-amzn-waf-action` 头 → WAF（isUnavailable）；HTTP 429/业务忙码 → isRateLimited（核心层指数退避：500ms 起，×2，上限 3 次后 429 报出）。
- 超长转录由核心层截断/报错（§4.2）。

## 7. 认证与密钥

- 扩展面板生成 API Key：`sk-dapi-` + 32 字符 `crypto.getRandomValues`；存 `chrome.storage.local`（key：`apiKey`）。面板可复制/重置。
- 网站用法：`window.deepApiConfig = { apiKey }` 或每请求传 `apiKey`；缺失 → 401 `missing_api_key`；不符 → 401 `invalid_api_key`（恒定时间比较）。
- 单 key 管全部 provider（v1）；per-provider key 留 v2。
- 不记录、不落盘任何凭证（浏览器自身持有的 Cookie 除外，按需读取）；日志不含消息内容与 API Key。

## 8. 桥接层协议与 API 面

### 8.1 内容脚本

- `bridge-main.ts`：`world: 'MAIN'`，注入 `window.deepApi`。API 面（OpenAI 形态）：

```ts
window.deepApi = {
  chat: { completions: { create(params): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> } },
  models: { list(): Promise<{ object, data: ModelInfo[] }> },   // v1: deepseek-chat / deepseek-reasoner
};
type Params = { model: string; messages: Message[]; stream?: boolean;
                tools?: Tool[]; tool_choice?: ToolChoice; apiKey?: string; conversation_id?: string };
```

- `bridge-relay.ts`：ISOLATED world，`chrome.runtime.connect` 持久 port，转发 window 消息，流式事件回推。
- 内部消息协议（`window.postMessage`，`event.source === window` 校验 + 结构校验）：`{ __deepApi: { id, method: 'chat.completions.create'|'models.list', params } }`；回包 `{ id, ok: true, data }` / 流式 `{ id, chunk }` / `{ id, done }` / 错误 `{ id, ok: false, error: {message,type,code} }`。
- 长流保活：relay 在流活跃期间每 20s 发 ping（port 消息活动维持 SW 存活）。
- `chat.completions.create` 返回：`stream:false` → Promise 聚合结果；`stream:true` → 带 `[Symbol.asyncIterator]` 的对象，并暴露 `cancel(): Promise<void>`（触发 `stopStream` best-effort，Agent 取消场景）；错误一律 reject 带 `{error:{message,type,code}, status}` 的 BridgeError。
- MAIN world 脚本无外部依赖、不拦截/修改页面其他行为，体积控制在 3KB 量级。

### 8.2 面板（popup）

区块：Provider 状态卡（v1：DeepSeek；登录/已过期/未登录 + "登录"按钮开 `loginPageUrl`，tab 完成后自动检测）、API Key（生成/复制/重置）、接入 snippet 一键复制（apiKey 预填）、模型列表（含说明）、池大小（1–5，默认 2）、TTL（默认 30 分钟）、自动删除网页 Chat Thread（默认关；关=淘汰/失败/重建只解除本地映射，网页会话保留；开=真调 `delete_session` 删除）、请求日志（最近 20 条：时间/provider/model/状态/耗时/error）。UI 按注册表渲染 provider 列表（为多 provider 预留结构，v1 单卡）。

## 9. 存储 schema（chrome.storage.local）

```ts
{
  apiKey: string,                                          // 默认生成
  providers: { [providerId]: {
      poolSize: number, ttlMinutes: number,
      lastAuthStatus: AuthStatus, lastCheckedAt: number } },
  log: LogEntry[]   // 循环 20 条
}
```

## 10. 错误模型

| code | HTTP 语义 | 场景 |
|---|---|---|
| `missing_api_key` | 401 | 未传 key |
| `invalid_api_key` | 401 | key 不符 |
| `invalid_request_error` | 400 | messages 非法（结构/超长）、tool_parse_error、未知模型 |
| `rate_limited` | 429 | 网页端限流（退避后仍忙）、队列 60s 超时；附 `retry_after` 建议 |
| `provider_unavailable` | 503 | 未登录/登录过期/WAF/网络/超时；附可读 message |
| `internal_error` | 500 | 其余未知 |

## 11. 工程结构

```
extension/                # MV3 扩展（esbuild 构建，TS）
  manifest.json           # MV3；权限：cookies(chat.deepseek.com)、storage、
                          #   host_permissions:<all_urls>、content_scripts(MAIN+ISOLATED)
  src/background/         # sw.ts(入口) router.ts session-mapper.ts transcript-renderer.ts
                          #   tool-pipeline.ts chunk-encoder.ts queue.ts
                          #   providers/adapter.ts providers/deepseek/{adapter,pow,sse-patch,auth,models,client}.ts
  src/content/            # bridge-main.ts bridge-relay.ts
  src/popup/              # popup.{html,ts,css}
  src/shared/             # protocol.ts api-types.ts（三端共用类型）
tests/unit/               # vitest：渲染/映射/工具/编码/池/队列/key
tests/integration/        # router + mock adapter 全链路；桥接协议往返
tests/fixtures/deepseek/  # spike 录制（token 脱敏）
examples/demo-page/       # 演示页：接入 snippet + 用法（验收载体）
docs/superpowers/specs/   # 本文档
```

构建：esbuild 四个入口（sw ESM；bridge-main、bridge-relay、popup 为 IIFE）+ vitest。核心模块不 import chrome 能力（注入依赖）。

## 12. Spike（实施前，钉死契约）

带真实账号执行一次受控验证，产物为 fixture + 冻结的适配器契约：

1. Cookie 名与必需请求头组合实测（浏览器网络栈 vs WAF 202 判定）。
2. `create_session` 请求/响应结构；`completion` 完整载荷（model_type 后端值、parent_message_id 语义、thinking 开关效果）。
3. SSE Patch 协议实测：事件名、路径、片段类型、finish_reason 取值、usage 出现时机。
4. PoW：challenge JSON 字段（salt/expire_at 存在性）、wasm 求解与 `X-Ds-Pow-Response` 校验（200 通过为准）、wasm URL 可获取性。
5. 并发与限流行为：2 并行会话、连发节奏、429/202 响应码真实表现。
6. 超长转录的真实上限边界（163,840 字符附近的行为）。
7. 录制脱敏 fixture（pow、completion 正常/限流/WAF/401 各一）。

Spike 结论回填本规范 §6 后冻结，再进入实施计划。

## 13. 非目标（v2+）

文件/图片上传、deepseek-vl（vision）、搜索直连（search_enabled）、多账号池、per-provider API key、长历史滑动窗口/摘要、参数级流式 tool_calls、Kimi/Qwen/GLM 适配器、externally_connectable 备选通道、Chrome Web Store 分发、本地 HTTP 服务形态。

## 14. 风险

| 风险 | 缓解 |
|---|---|
| 内部 API 变更 | 契约隔离在 DeepSeekAdapter 单点；fixture 回归；参考 ds-free-api 生命周期（长期稳定） |
| ToS/账号风险 | 网页免费额度当 API 用属灰区；默认池 2、退避收敛；个人自用场景 |
| WAF 拦截 | 浏览器网络栈天然低风险；命中时 503 + 面板可读提示（换网络/重登） |
| user_token 轮换 | onChanged 监听 + 401 探测 → 面板立即提示重登 |
| 长流 SW 被杀 | 20s ping 保活 + 断流错误收敛（单次网页回复常见时长 < 10 分钟，spike 实测确认） |

## 15. 验收标准

- demo-page 用 snippet 完成：非流式 / 流式（含 reasoning_content）/ 工具调用三类对话各通过一次。
- 状态矛盾验证：A. 同一历史 + 新消息 → 网页侧可见增量续聊；B. 修改历史重发 → 新会话重答，无串台；C. 完整重放 → 正常重答。
- 面板：登录状态机正确；key 复制/重置生效；日志可读。
- 单测+契约测试+集成测试全绿（覆盖率：核心模块 ≥ 80%）。
- 全流程不拉起任何伴生进程。