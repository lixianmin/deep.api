# 2026-10-01 ChatGPT Provider：页面桥接（Page-Bridge）设计

## 1. 背景与目标

deep.api 当前的 provider 只有 DeepSeek，走的是「扩展自己当 HTTP 客户端」路线：content script 从
`chat.deepseek.com` 的 localStorage 读 `userToken` 同步给 SW，SW 带 `Authorization: Bearer` 直接
打 `https://chat.deepseek.com/api/v0/chat/completion`。本设计为 ChatGPT 增加第二个 provider。

目标：让 `POST /v1/chat/completions` 能把消息发到 ChatGPT 网页版并流式返回，同时满足
spice（唯一外部调用方）对 SSE 分块、tool_calls、reasoning 字段的既有期望。

明确不做：官方 OpenAI API（用户无 key，且与本项目「把网页版变成接口」的前提无关）。

## 2. 为什么不能照抄 DeepSeek 路线

DeepSeek 的 REST 后端（`/api/v0/*`）只要一个 Bearer token 就能直接调。ChatGPT 不行：

实测（2026-10-01，详见 `docs/01.memory.md` 的 ChatGPT 调研条目）：

1. **主聊天发送的真实端点是 `POST /backend-api/f/conversation`**（2026-10-01 实测更正）。
   此前本节写的是 `/backend-api/sidebar/conversation`——**该路径确实存在**（对它 POST 会得到
   规范的 Pydantic 422，body 必填 `conversation_id`（string，新会话 `""`）与 `message_id`），
   但它**不是主聊天流走的路**。误判来源：在一个 1675B 的 chunk 里读到该字面量，而它属于
   sidebar 内联聊天分支。主聊天流走 `/f/conversation`，同族还有 `/f/conversation/prepare`。
   ⚠️ 教训：静态读到的字面量不等于实际流量，必须用 Resource Timing 以
   `initiatorType` 为准反查真实请求。
2. Bearer 认证本身可用：`GET /api/auth/session` 的 `accessToken`（1690 字符 RS256 JWT）配
   `Authorization: Bearer` 打 `/backend-api/*` 实测 200。**但只带 cookie（`credentials:include`）
   会得到误导性错误** `"Log in to view this conversation"`，排查时必须先试 bearer。
3. **致命点**：请求必须带三个 sentinel 头 `chatReq` / `turnstileToken` / `proofToken`，
   由 `sentinel/chat-requirements → prepare → sentinel/frame.html（iframe）→ finalize`
   的交互式握手产生。MV3 service worker 无 DOM、不能托管 iframe，**无法复现**。
4. 缺这三个头时**不报错**：返回 HTTP 200 + `data: [DONE]`（14 字节空流）。静默失败，
   排障成本极高。

结论：扩展自己当客户端这条路判死。

## 3. 架构：页面桥接

核心思路：**不让扩展伪造请求，而是让真实网页发真实请求，扩展在旁边抄。**
页面自己的 auth 与 sentinel 握手全部原生完成，必然有效。

```
spice ──HTTP──> 扩展 SW ──port──> MAIN world content script ──> chatgpt.com 页面
                    ^                                                  │
                    └──── SSE 帧（旁路复制） ─────────────────────────┘
```

### 3.1 请求路径（发消息）

spice 发消息时，SW 经 port 通知 chatgpt.com 上的 MAIN world 脚本，由它驱动页面。
**顺序有严格要求**（每一步都来自实测踩过的坑）：

1. **确认页面停在目标会话上**（见 §3.4 配对与导航）；不在则先切换，不在则报错
2. 清 `localStorage` 中匹配 `/draft/i` 的键。必须在触发 composer 读取之前——
   ChatGPT 会把 `oai/apps/conversationDrafts` 的旧草稿恢复进输入框，
   实测出现过 `"Say PONGSay PONGReply with exactly: ALPH"` 这种拼接污染
3. 清空 composer。`#prompt-textarea` 是 **contenteditable div，不是 `<textarea>`**，
   没有 `.select()` 方法（实测 `ta.select is not a function`）；必须用
   `Range.selectNodeContents` + `Selection.addRange` 后 `execCommand('delete')`
4. `execCommand('insertText')` 写入消息，随后**回读 `innerText` 校验非空**
5. 等 `button[data-testid="send-button"]` 出现且非 disabled，完整 pointer 序列点击

**第 2 步不能省略第 3 步**：清 localStorage 不会清掉页面内存里已恢复的草稿，
实测两者都要做。同理，第 3 步不能省——清完 localStorage 后 composer 仍可能有残留。

**必须等页面就绪**：实测在标签页刚加载完立刻点击会**静默失败**（会话不创建、无报错）。
扩展需等待 composer + send 按钮就绪，而非页面 load 事件。

### 3.2 响应路径（拿回复）

关键约束（实测决定架构）：

- **页面 JS 在后台标签页里正常运行，流被页面接收并持有；被节流的只是 React 渲染。**
  早前实测：后台发消息后 assistant 消息在 DOM 里一直是空的，切到前台瞬间立刻补全。
  ⚠️ **但该证据已被推翻，不可依赖。** 重测时发现 ChatGPT 每轮会渲染**两个** assistant
  元素：一个空占位 + 一个真实内容。早期脚本用「最后一个 assistant 元素」读内容，
  读到的永远是空占位，因此「后台为空」与「切前台补全」都可能是测量假象。
  正确读法是**取所有 assistant 元素 `textContent` 长度的最大值**。
  （也不能用 `innerText`：它只返回已渲染可见文字，回复渲染成折叠块时恒为空——
  实测一条 `:::writing` 块回复在 `innerText` 下为 0、`textContent` 下有内容。）
  **结论降级为待验证**，见 §7.1。
- **不能用轮询拿流式**：`GET /backend-api/conversation/<id>` 是**原子返回**的，
  实测回复从 0 直接跳到 50 字符、状态已是 `finished_successfully`，无任何中间态可观测。
  轮询只能拿整段，无法满足 spice 的流式期望。
- **运行期 patch `window.fetch` 无效（已证实，非推断）**：2026-10-01 二次实测，本次
  **同时校验了发送确实发生**（新会话 `6abe1337` 创建、发送脚本返回 sentOk），
  抓到的请求数仍为 **0**。故 bundle 确在模块初始化时持有了 `window.fetch` 引用。
  上一轮「抓到 0 个」无法排除「当时发送本身失败」的干扰，本次已排除。
  → `document_start` MAIN world 注入是**硬性前提**，不是优化项。

因此唯一可行钩点：**MAIN world、`document_start` 时机**——在页面 bundle 读取
`window.fetch` 之前完成 patch，bundle 随后捕获到的就是被包装过的版本。
本仓已有同款基建（`src/content/bridge-main.ts`，`run_at: document_start` + `world: MAIN`）。

包装逻辑：请求照常发出（不动 headers/body，保住原生 auth 与 sentinel），但对
`/backend-api/f/conversation` 的响应做 tee，一路照常返回给页面，
另一路把 SSE 帧逐块转给 SW。

**tee 两侧都必须被消费**：若只读页面那一侧，未读的分支会滞住并向 socket 反压，
最终把页面自己的流也拖死。因此桥接侧必须**主动 pump**，不能等下游准备好再读；
桥接侧只做「解析 + 转发 + 丢弃」的重活要做在流之外，不能在读取循环里做阻塞计算。

### 3.3 SSE 帧映射

页面收到的是 ChatGPT 自有帧格式。SW 侧转成 `ProviderStreamEvent` 后由既有 router
编码为 OpenAI 形态（`src/background/chunk-encoder.ts` 已有该能力，DeepSeek 在用）。
本设计不新增编码器，只新增「ChatGPT 帧 → ProviderStreamEvent」的解析。

### 3.4 配对与导航（实现前必须先定，否则必卡）

谁发起的 spice 请求，与捕到的哪条 SSE 流对应，必须有确定规则。**不能用「最后一条流」
这种裸假设**——单标签页串行只是当前预期，并发下会错配。

采用 SW 侧**待处理队列（pending queue）**：

1. SW 收到 spice 请求 → 压入 pending 项（含 provider requestId），经 port 通知 content script 发送
2. content script 点击前先读 `location.pathname` 取当前 conversation_id，一并回传
3. SSE wrapper 每捕到一条流，从其请求 body/URL 解析出 conversation_id，与队首匹配后出队
4. **首轮无 conversation_id**：新建会话时以「队首 + 发出时间序」匹配，并在
   content script 侧记录点击后新出现的 `/c/<uuid>` 作为该 pending 的确定归属
5. 匹配不到或队首超时（如 60s）→ 报 503 `provider_unavailable`，**不得静默丢弃**
   （呼应 §2 第 4 点：上游的失败模式就是静默，这里不能重蹈）

**导航**：多轮要求页面停在映射的会话上。若 `location.pathname` 与目标不符：
- 不擅自 `location.href = ...`（会摧毁用户当前浏览状态与该标签页历史）
- 优先点击侧边栏历史项（title 已实测可取，如 `/backend-api/conversations`）
- 历史项找不到（会话太老）才导航到 `/c/<uuid>`，并**记 warning 日志**
- 无法定位 → 报错，不发送

### 3.5 登录态与标签页缺失

- **登录态**：与 DeepSeek 的 token 探测不同，本 provider 的 `getAuthStatus` 由
  content script 判定——chatgpt.com 页面存在且未出现登录提示即为 `logged_in`。
  SW 侧不持有 ChatGPT token（它只存在于页面，桥接也不需要它）。
- **标签页缺失**：没有打开的 chatgpt.com 标签页时，
  行为需显式定义。建议：**不自动开**（避免惄惄往用户窗口里塞标签页），
  首次使用时由 popup 引导用户打开并登录；SW 侧返回 503 并携带明确文案
  「请先在浏览器中打开并登录 chatgpt.com」。沿用 DeepSeek 现有的
  `resyncAuth` 手动开 tab 的做法（用户已在 popup 点过），不新增自动开逻辑。

### 3.6 串行化

单标签页同一时刻只能跑一轮对话。pending 队列天然串行：上一轮未出队前不发送下一轮。
超时则丢弃并报错，不得叠加发送。

## 4. 必须先修的架构泄漏

现有 provider 抽象名义上通用，实则处处是 DeepSeek 假设。接第二个 provider 前必须清理，
否则 ChatGPT 路径会带着 DeepSeek 语义跑：

| 位置 | 问题 |
|---|---|
| `src/background/providers/adapter.ts` | `modelType: 'default'\|'expert'\|'vision'` 是 DeepSeek wire 词汇，却写在共享类型里；`auth.cookieDomain` / `requiredCookies` 早已失效（auth 早已改 localStorage JWT） |
| `src/background/router.ts:11` | 直接 import `createDsmlStreamNormalizer`，导致所有 provider 的流都过 DeepSeek 的 DSML 归一化 |
| `src/background/providers/registry.ts` | `createRegistry(provider)` 只收一个 adapter，是单 provider 桩 |
| `src/background/sw.ts` | 硬编码 `'deepseek'` 约 15 处（config、auth status、tab URL、设置项） |
| `src/content/models-sync.ts` | 网页 UI label 抓取脚本，被 router 直接 import 进 background |

处理原则：把「provider 特有」的部分收进各自 adapter，共享层只留真正通用的契约。
DSML 归一化应变为 DeepSeek adapter 的可选能力，由 adapter 自己声明是否需要。

### 4.1 实施拆分（重要）

本设计实际是两段工作，必须分开落地，不要混在一个提交里：

**阶段 A · 纯重构，零外部行为变化。** 只做上表五处清理：抽出真正的多 provider 注册、
把 DeepSeek 词汇下沉进 DeepSeek adapter、DSML 归一化改为 adapter 自声明。
验收标准是**现有 494 个测试全绿且不改断言**——因为对外行为必须逐字节不变。
这一步单独可交付，且是阶段 B 的地基。

**阶段 B · ChatGPT page-bridge provider。** 在阶段 A 收拾干净的地基上新增 provider。
引入 content script 桥接、SSE 解析、conversation 映射等新逻辑。

拆分的理由：阶段 A 若与新 provider 混在一起，一旦回归就无法判断是重构改坏了还是新代码有 bug；
而阶段 A 本身有明确且廉价的验收信号（老测试不动）。

## 5. 多轮与 session 映射

ChatGPT 有真实 conversation 概念（`/c/<uuid>`），比 DeepSeek 的 `chat_session_id` 更直接：

- 同一个 OpenAI `conversation_id` → 固定映射到一个 chatgpt.com conversation，页面停在该会话
- 换 `conversation_id` → 点「新对话」并映射到新会话
- 页面端会话会累积（用户可见）。清理策略复用 DeepSeek 已有的 `autoDeleteWebThreads`
  设置项（popup 里的 checkbox，**默认关**），语义一致：关闭时只解除本地映射、保留网页会话；
  开启时才真删。ChatGPT 侧对应 `DELETE /backend-api/conversation/<id>`
- 不实现「编辑已发消息」——与 DeepSeek 现状一致，v1 不做

## 6. 已知限制（明确接受）

1. **浏览器里必须开着 chatgpt.com 标签页**，无法完全无头运行。实测后台标签页可用，
   但**窗口最小化 / 被完全遮挡 / 标签页被内存回收**三种情形未验证，Chrome 对它们节流更激进。
   预期用法：单独开一个小窗口放着，不要最小化。
2. **依赖 ChatGPT 页面实现**，他们改版可能失效。`document_start` 注入时点与端点路径都是
   硬约定，`sidebar/` 这一级就是活生生的例子。
3. **账号是 Free 档**，额度与速度受账号限制。
4. **单标签页串行**：一个 chatgpt.com 标签页同一时刻只能处理一轮对话，并发请求需排队。
5. 页面会残留测试会话，需手动清理。

## 7. 验证方式

### 7.1 阶段 B 第一道闸门 —— **已通过（2026-10-01 实测）**

**结论：流式成立，且后台标签页可读。阶段 B 可以开工。**

实测数据（Resource Timing，`initiatorType: fetch`，以点击时刻为基准）：

| 场景 | 端点 | TTFB | 下载持续 | 解码字节 |
|---|---|---|---|---|
| 前台 | `/backend-api/f/conversation` | 1802ms | **4369ms** | 9128 |
| **后台**（`focused:false`） | `/backend-api/f/conversation` | — | **4464ms** | 8098 |

TTFB 后仍有数秒持续下载 = 教科书式 SSE。后台与前台**数值一致**，说明后台标签页
的 JS 会完整消费该流，被节流的只是 React 渲染（与 §3.2 的降级结论一致，现已证实）。

sentinel 握手在同一窗口内并行完成（`chat-requirements/finalize` 3170B、
`/f/conversation/prepare` 384B、多次 `sentinel/ping`）。

**本轮踩到的仪器错误（勿重蹈）**：

1. 第一版 tap 脚本的正则 `\/backend-api\/(sidebar\/)?conversation` **无词边界**，
   把 `conversations`（会话列表，24,462B）误判成流式请求，一度得出「整体缓冲」的假结论。
   真实数字对得上：tap 抓到的 24462B 与该列表接口的 `decodedBodySize` 完全一致。
2. tap 只保留最后一条匹配记录，覆盖掉了真正的目标请求。
3. Resource Timing 过滤同样漏了 `/f/` 这一级，导致「端点不存在」的假象。
4. `dl` 判定脚本里用截断路径做精确字符串比较，误报「没有该条目」。

**最终结论以 Resource Timing 为准**：`dl`（responseEnd − responseStart）跨秒 = 真流式；
`dl≈0` 而 `dec` 很大 = 整体缓冲。Resource Timing 是比 DOM 观测可靠得多的仪器
（DOM 观测已被 §3.2 记录的「空占位元素」问题证伪过一次）。

### 7.2 其余验证

- 单元测试：SSE 帧解析、draft 清理、composer 清空、conversation 映射、pending 队列配对与超时
- 集成测试：stub content script 驱动 + stub SSE 帧，验证 router 产出的 OpenAI 形态分块
- 手工验收：真实 chatgpt.com 标签页，后台状态下经 spice 发一轮并观察流式分块

## 8. sentinel iframe 实测（2026-10-01 二次）

结论：**在真实页面内原生跑通**；token 取不出来，故「页面供 token + SW 自己发」不成立。

一次真实发送中用 Resource Timing 观测到的完整握手序列（`initiatorType` 为浏览器标注）：

| # | 请求 | 发起方 |
|---|---|---|
| 1 | `/backend-api/sentinel/sdk.js` | script |
| 2 | `/backend-api/sentinel/chat-requirements/prepare` | fetch |
| 3 | `/backend-api/sentinel/ping`（多次） | fetch |
| 4 | `/sentinel/20260810913b/sdk.js` | script |
| 5 | `/backend-api/sentinel/frame.html?sv=20260810913b` | **iframe** |
| 6 | `/backend-api/sentinel/chat-requirements/finalize` | fetch |

补充事实（均实测）：

- 该 iframe **同源**（`chatgpt.com`）且**常驻 DOM**，版本由 `sv=20260810913b` 标定
- iframe 内容为空（bodyLength=0、无嵌套 frame），页面 window 上也无相关全局变量
  → **三个 token 关在 bundle 闭包里，取不出来**
- 消息本身发送成功（会话创建、assistant 消息在服务端落库）

这正是「让真实页面发真实请求」比「扩展自己当客户端」更可靠的根本原因，
也与 memory 里「MV3 SW fetch 永远不是浏览器形状」的封号调研结论相互印证。

## 9. 备选方案与否决理由

- **扩展自己当客户端（复刻 sentinel）**：iframe 握手无法在 SW 中复现，否决。
  且 token 不可从页面取出（见 §8），走不通「页面供 token + SW 发」的折中。
- **轮询 conversation 接口**：原子返回，无流式，否决。
- **页面供 token + SW 自己发**：token 在 bundle 闭包内，取不出，否决（见 §8）。
- **读 DOM**：后台标签页不渲染，否决（前台可用但违背免打扰诉求）。
- **填 composer + 轮询接口**（最省事）：能跑通但无流式，作为降级保底，
  若 SSE 桥接失败可回退到此。
