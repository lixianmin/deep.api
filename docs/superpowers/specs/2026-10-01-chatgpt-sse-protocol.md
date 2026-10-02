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
3. **`p:""` + `o:"patch"` 的 `v` 是操作数组**，要再展开一层，对每项按同样的
   规则处理（正文续帧就在这个数组里）。
4. **推理/正文分界看 `message_marker`**：`final_channel_token` 之前的正文属
   reasoning（→ `think_delta`），之后属正文（→ `content_delta`）。
5. **完成信号**：出现 `/message/status = finished_successfully`，或
   `{"type":"message_stream_complete"}`；流末尾是 `data: [DONE]`。
6. 可忽略的帧：`title_generation`、`server_ste_metadata`、
   `conversation_followup_suggestions_eligible`。
7. **错误信号**：快照里的 `error` / `error_code` 字段非空。

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
