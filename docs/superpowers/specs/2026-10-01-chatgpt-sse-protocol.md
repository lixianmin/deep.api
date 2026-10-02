# ChatGPT 网页 SSE 协议与请求体（2026-10-01 实测抓帧）

本文是 `2026-10-01-chatgpt-page-bridge-design.md` 的配套实测记录：设计阶段靠逆向拿到的
"端点"与"请求体"两处当时**是错的**，本文以真实抓帧为准。

## 抓帧方法（两个非显然的前提，都是踩坑换来的）

1. **必须在 `document_start` 打补丁。** 页面加载完后用 AppleScript 注入 patch
   `window.fetch` / `Response.prototype.body` / `.text` / `.json` /
   `ReadableStream.getReader` **全部无效**——bundle 在模块初始化时已取走这些引用。
2. **结果必须经 DOM 暴露，不能放 `window`。** AppleScript 的 `execute javascript`
   跑在**隔离世界**，与 MAIN world 共享 DOM 但**不共享 `window`**。
   早期用 `window.__sseTap` 读状态永远读不到，误判成"脚本没跑"，白排查很久。
   （同源 `<script>` 注入桥接也不行——chatgpt.com 的 CSP 会拦内联脚本。）

## 端点更正

- 真实端点：`POST /backend-api/f/conversation`（**不是** `/backend-api/sidebar/conversation`，
  那个属于 sidebar 内联聊天分支）
- 旁路：`/backend-api/f/conversation/prepare`、`/backend-api/sentinel/*`
- 确认流不在 Worker 里（`Worker` 构造器未被调用）→ MAIN world 挂钩成立

## 请求体（真实抓取，新会话）

```json
{
  "action": "next",
  "messages": [{
    "id": "<uuid>",
    "author": {"role": "user"},
    "create_time": 1790899101.809,
    "content": {"content_type": "text", "parts": ["<用户文本>"]},
    "metadata": {"serialization_metadata": {"custom_symbol_offsets": []},
                 "submission_mode": "manual_send"}
  }],
  "parent_message_id": "client-created-root",
  "model": "auto",
  "client_prepare_state": "success",
  "timezone_offset_min": -480,
  "timezone": "Asia/Shanghai",
  "conversation_mode": {"kind": "primary_assistant"},
  "supported_encodings": ["v1"],
  "client_contextual_info": { "...": "页面尺寸/暗色/pixel_ratio 等" }
}
```

**关键更正**：新会话**根本不传 `conversation_id`**（设计稿里写的 `conversation_id: ""` 是错的）。
会话 id 由响应首帧回传。

## SSE 帧协议（逐帧实测，18 帧 / span 6783ms / INCREMENTAL）

帧序列（`event:` 为空表示只有 `data:` 行）：

| # | event | data |
|---|---|---|
| 1 | `delta_encoding` | `"v1"` |
| 2 | — | `{"type":"resume_conversation_token","conversation_id":"<uuid>","token":"<JWT>"}` |
| 3 | `delta` | `{"p":"","o":"add","v":{message 快照},"c":0}` |
| 4-5 | `delta` | `{"v":{message 快照},"c":1}` / `{"c":5}`（`p`/`o` 继承） |
| 6 | — | `{"type":"message_marker","marker":"user_visible_token","event":"first"}` |
| 7-8 | `delta` | `{"c":8}` / `{"c":9}` |
| 9 | — | `{"type":"message_marker","marker":"user_visible_token\|final_channel_token","event":"first"}` |
| 10 | `delta` | `{"p":"/message/content/parts/0","o":"append","v":"1\n2\n3\n4\n5\n6\n"}` |
| 11-12 | `delta` | `{"v":"7\n8\n9\n10\n"}` / `{"v":"11\n...\n28"}`（`p`/`o` **继承上一帧**） |
| 13 | `delta` | `{"p":"","o":"patch","v":[ {"p":"/message/content/parts/0","o":"append","v":"\n29\n...\n60"}, {"p":"/message/status","o":"replace","v":"finished_successfully"}, {"p":"/message/end_turn","o":"replace","v":true}, {"p":"/message/metadata","o":"append","v":{"is_complete":true,...}} ]}` |
| 14 | — | `{"type":"message_marker","marker":"last_token","event":"last"}` |
| 15-16 | — | `{"type":"title_generation"}` ×2（可忽略） |
| 17 | `delta` | `{"p":"/message/metadata/conversation_followup_suggestions_eligible","o":"replace","v":false}` |
| 18 | — | `{"type":"server_ste_metadata"}`（可忽略） |
| 19 | — | `{"type":"message_stream_complete"}` |
| 20 | — | `data: [DONE]` |

## 解析规则（写 parser 直接照此实现）

1. **正文 path = `/message/content/parts/0`，op = `append`，`v` 是纯文本增量。**
2. **`p`/`o` 跨帧继承**：只带 `{"v":"..."}` 的帧沿用上一条 delta 的 `p`/`o`。
   实测这就是正文续帧——**这是最容易写错的地方**。
3. **帧级 `v` 是操作数组 = ops 批次，要再展开一层**，对每项按同样的规则处理
   （正文续帧就在这个数组里）。批次实测有**两种形态**，必须都认：
   - 文档/初始形态：`{"p":"","o":"patch","v":[ops]}`
   - **实测更常见的形态：`{"v":[ops]}`——帧级根本没有 `p`/`o`**

   **坑（2026-10-05 用户实测踩中，正文被吞 65%）：不能把 `p === ""` 当作批次判据。**
   因为规则 2 的继承生效后，帧级无 `p`/`o` 时 `p` 会继承成 `/message/content/parts/0`、
   `o` 继承成 `append`，判据不成立 → 批次不展开 → 落到「单条 op」分支 → `v` 是数组不是字符串
   → 整批 ops（含正文）静默丢弃。表现：回复丢字、错位、结尾断在半句，且无任何报错。
   判据应基于 `v` 的形态：`Array.isArray(v)` 且（`o === 'patch'` 或 每个元素都是带字符串 `p`
   的非数组对象）。**反例别误判**：`/message/metadata/content_references/...` 下的
   `v:["https://…"]`（字符串数组）与 `v:[{matched_text:…}]`（无 `p` 的对象数组）都是普通 op 值，
   不是批次。批次可嵌套，展开函数应递归。
4. **引用标记（联网回答时必有）**：正文内联着 `U+E200` `cite` `U+E202` `turn0newsN` `U+E201`
   形态的私有区标记（网页 UI 把它渲染成来源角标）。**三个码点固定：U+E200 起、U+E202 分隔、
   U+E201 止**。作为 API 文本返回时必须**删掉**（用户 2026-10-05 拍板：不换链接、不留来源名）。
   清洗必须**有状态**：正文流式分片到达，标记可能**被 delta 切断**（一帧以 `\uE200cit` 结尾、
   下一帧以 `e\uE202turn0news2\uE201` 开头），遇到未闭合的 U+E200 要扣住半截等下帧，
   不能直接正则一把梭。扣留要有**长度上界**（64 字符，实测标记约 20 字符的 3 倍余量）：
   超界仍未闭合就不是标记，原样放出——否则一段残缺标记会静默吞掉后面整段回答
   （用户真实数据里出现过 `…北京天气如下：\uE200cite\uE202turn0` 这种残缺形态）。
4. **推理/正文分界看 `message_marker`**：`final_channel_token` 之前的正文属
   reasoning（→ `think_delta`），之后属正文（→ `content_delta`）。
5. **完成信号**：出现 `/message/status = finished_successfully`，或
   `{"type":"message_stream_complete"}`；流末尾是 `data: [DONE]`。
6. 可忽略的帧：`title_generation`、`server_ste_metadata`、
   `conversation_followup_suggestions_eligible`。
7. **错误信号**：快照里的 `error` / `error_code` 字段非空。

**真实回归素材**：`tests/fixtures/chatgpt-frames-news.json`（一次真实联网回答的 36 帧抓帧）+
`tests/unit/chatgpt-stream.test.ts` 里逐字比对的 536 码点期望正文。改 parser 必跑这条。

## 与 DeepSeek 的关系

`{p, o, v}` 的 path/op/value 形态**与 DeepSeek 网页 SSE 同构**（memory 决策 #7 记录过
DeepSeek 的 `{"p":"response/content","o":"APPEND","v":"你好"}` 与"续帧省略 p/o 继承上式"）。
差异：ChatGPT 用 JSON-pointer 风格 path + 小写 op（`append`/`replace`/`add`/`patch`），
且有 `message_marker` 做通道分界。`src/background/providers/deepseek/sse-patch.ts`
的事件循环骨架可参考，但**不能直接复用**——path 语义与快照帧处理不同。

## 另一条实测结论：composer 有反自动化 fallback

页面未水合完成时，输入框是 `<textarea class="wcDTda_fallbackTextarea">` 而非
`#prompt-textarea`（contenteditable）。此时点 send 只会触发
`GET /?prompt-textarea=...` 表单导航，**根本不是发送**。实现必须：
等待 `#prompt-textarea`（contenteditable）出现后再填词，且**不能**用 send 按钮
的存在与否作为就绪判据（它要等有文字才出现，与 composer 就绪是鸡生蛋死锁）。
