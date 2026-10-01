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

1. 端点是 `POST /backend-api/sidebar/conversation`，**不是** `/conversation`（少一级 `sidebar/`
   会得到 422 `Invalid conversation body`）。body 必填 `conversation_id`（string，新会话传 `""`）
   与 `message_id`（string）。
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

spice 发消息时，SW 经 port 通知 chatgpt.com 上的 MAIN world 脚本，由它驱动页面：

1. 清 `localStorage` 里匹配 `/draft/i` 的键（实测 ChatGPT 会把 `oai/apps/conversationDrafts`
   里的旧草稿恢复进 composer，导致提示词被拼接——实测出现过
   `"Say PONGSay PONGReply with exactly: ALPH"` 这种污染）
2. 清空 composer：`#prompt-textarea` 是 **contenteditable div，不是 `<textarea>`**，
   没有 `.select()`；必须用 Range + Selection API 全选后 `execCommand('delete')`
3. `execCommand('insertText')` 写入消息
4. 等 `button[data-testid="send-button"]` 出现且非 disabled，完整 pointer 序列点击

**必须等页面就绪**：实测在标签页刚加载完立刻点击会**静默失败**（会话不创建、无报错）。
扩展需等待 composer + send 按钮就绪，而非页面 load 事件。

### 3.2 响应路径（拿回复）

关键约束（实测决定架构）：

- **页面 JS 在后台标签页里正常运行**，流被接收并缓存；被节流的只是 **React 渲染**。
  实测：后台发消息后 assistant 消息在 DOM 里一直是空的，**切到前台瞬间立刻补全**。
  → 因此在后台挂 fetch 照样能抄到 SSE 帧。
- **不能用轮询拿流式**：`GET /backend-api/conversation/<id>` 是**原子返回**的，
  实测回复从 0 直接跳到 50 字符、状态已是 `finished_successfully`，无任何中间态可观测。
  轮询只能拿整段，无法满足 spice 的流式期望。
- **运行期 patch `window.fetch` 无效**：实测已确认发送成功（会话创建、composer 清空）但
  抓到 0 个请求。原因是 bundle 在模块初始化时就持有了 `window.fetch` 的引用。

因此唯一可行钩点：**MAIN world、`document_start` 时机**——在页面 bundle 读取
`window.fetch` 之前完成 patch，bundle 随后捕获到的就是被包装过的版本。
本仓已有同款基建（`src/content/bridge-main.ts`，`run_at: document_start` + `world: MAIN`）。

包装逻辑：请求照常发出（不动 headers/body，保住原生 auth 与 sentinel），但对
`/backend-api/sidebar/conversation` 的响应做 tee，一路照常返回给页面，
另一路把 SSE 帧逐块转给 SW。

### 3.3 SSE 帧映射

页面收到的是 ChatGPT 自有帧格式。SW 侧转成 `ProviderStreamEvent` 后由既有 router
编码为 OpenAI 形态（`src/background/chunk-encoder.ts` 已有该能力，DeepSeek 在用）。
本设计不新增编码器，只新增「ChatGPT 帧 → ProviderStreamEvent」的解析。

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
- 页面端会话会累积（用户可见），需提供清理入口
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

- 单元测试：SSE 帧解析、draft 清理、composer 清空、conversation 映射
- 集成测试：stub content script 驱动 + stub SSE 帧，验证 router 产出的 OpenAI 形态分块
- 手工验收：真实 chatgpt.com 标签页，后台状态下经 spice 发一轮并观察流式分块
- 必测：后台标签页下 SSE 分块是否逐块到达（依赖 §3.2 的核心假设）

## 8. 备选方案与否决理由

- **扩展自己当客户端（复刻 sentinel）**：iframe 握手无法在 SW 中复现，否决。
- **轮询 conversation 接口**：原子返回，无流式，否决。
- **读 DOM**：后台标签页不渲染，否决（前台可用但违背免打扰诉求）。
- **填 composer + 轮询接口**（最省事）：能跑通但无流式，作为降级保底，
  若 SSE 桥接失败可回退到此。
