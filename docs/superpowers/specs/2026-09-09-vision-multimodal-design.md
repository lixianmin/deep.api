# Vision Multimodal — 图片上传支持设计

**日期**：2026-09-09
**状态**：草案，待 review
**触发**：spice 端 agent 需调 DeepSeek vision 模型查图（电路图、截图等）

---

## 1. 目标与边界

**In scope**：
- DeepSeek vision 模型（`deepseek-v4-flash-vision-exp`）支持图片输入
- 调用方（spice 端 / 第三方 LLM 客户端）通过 OpenAI 兼容 ChatCompletion API 传图
- deep.api 完成 image → file upload → 主请求转发，整条链路透明

**Out of scope**（v1 不做）：
- 图片缓存（同 session 同图 hash 复用 OCR）
- 并发 vision / 多图 batch OCR
- vision 输出的 markdown 渲染优化
- 官方 OpenAI API（`api.deepseek.com`）接入 —— 当前 deep.api 仅走 `chat.deepseek.com/api/v0` 网页 API 路径

---

## 2. 根因（spike 结论，2026-09-09）

**修正**：之前推断 "vision 模型是 side agent" 是错的。**DeepSeek vision 模型是端到端聊天模型**——它自己看图、自己调工具、自己回复。证据：

- DeepSeek 官方文档（`api-docs.deepseek.com`）：`deepseek-v4-flash-vision-exp` 接受 image input
- llmweb2api 主 completion payload（`index.ts:114`）：
  ```ts
  {
    model_type: modelType,    // 'vision' / 'default' / 'expert'
    prompt,
    ref_file_ids: refFileIds, // 主请求直接传 file_ids
  }
  ```
  → **主请求带 ref_file_ids，vision 模型自己处理图片**
- llmweb2api `runVisionSideSession`（`index.ts:603`）只在 `hasImageMessage + 非 vision 模型` 时跑 —— 是为了**让 default/expert 模型也能"看图"**（通过文本描述），不是 vision 的必需

**chat.deepseek.com/api/v0 接受 OpenAI 兼容 content array**：
- `messages[].content` 可为 `string | Array<{type, text?, image_url?: {url}}>`
- `image_url.url` 支持 `data:image/...;base64,...` 和 `http(s)://`
- 服务端不直接看 image_url —— 必须先 file upload 转 `file_id`，再传 `ref_file_ids`

---

## 3. 接口设计

### 3.1 ChatCompletion API 接受 vision content

调用方请求示例：
```json
{
  "model": "deepseek-v4-flash-vision-exp",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "这个电路图有故障吗？"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}}
    ]
  }],
  "tools": [...]
}
```

### 3.2 Router 行为矩阵

| model | content 类型 | 行为 |
|---|---|---|
| `flash` / `pro` / `vision-exp` | `string` | 现有行为（无图） |
| `flash` / `pro` | array（含 image） | **400** `invalid_request_error`：vision 图片不支持 v1（保留 v0.1.66 拒绝行为） |
| `vision-exp` | array（仅 text 块） | 等价 string（忽略 image_url 缺位警告） |
| `vision-exp` | array（含 image_url 块） | **触发 vision pipeline**（§4） |

### 3.3 错误语义

- `image_url.url` 不是 data URL 也不是 http(s) URL → 400
- file upload 失败 → 400 `invalid_request_error`（透传 deepSeek 服务端错误码）
- pollFileReady 超时（默认 30s）→ 408
- vision 临时 session 失败 → 500
- **不静默降级**：失败必须显式报

---

## 4. Vision Pipeline（新增 `src/background/vision-pipeline.ts`）

### 4.1 流程

```
调用方请求（vision + image_url）
  ↓
router 识别 vision + array content 含 image_url
  ↓
vision-pipeline.run(message, token):
  1. 抽 image_url blocks（按 OpenAI 格式）
  2. 对每个 image_url:
     a. data URL → 解码 base64 → bytes + mime
     b. http(s) URL → fetch 下载 → bytes + mime
     c. uploadFile(token, filename, bytes, mime) → file_id
     d. pollFileReady(token, file_id) // 默认 30s，超时报错
  3. 重写 messages:
     - text 块保留
     - image_url 块替换为 `[image]` 占位符（参考 llmweb2api `renderMessageBlock`）
  4. 返回 { messages: rewrittenMessages, refFileIds: string[] }
  ↓
router 转发到 chat.deepseek.com/api/v0 completion:
  payload = { ...existingPayload, ref_file_ids: refFileIds, prompt: renderedPrompt }
```

### 4.2 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 临时 session | **不用** | 主请求的 chat_session_id 直接带 ref_file_ids，vision 模型端到端处理 |
| 主模型选择 | **不动**（调用方传啥用啥） | vision-exp 端到端；不降级 flash |
| Side session OCR | **不用** | 仅 vision 模型自己看图 |
| image_url 渲染 | 替换为 `[image]` 占位 | llmweb2api 实证可用；prompt 文本可读，ref_file_ids 携带实际图 |
| 缓存 | **不做** | v1 范围外，每次都重传 / 重 OCR |
| 临时资源清理 | file_id 不主动删 | DeepSeek 服务端有 TTL（参考 pollFileReady 行为） |

### 4.3 复用 deep.api 已有能力

- `auth.ts`：token 取 cookie / headers（vision 上传用同一 token）
- `pow.ts`：pow challenge —— **file upload 是否需要 pow？待实现验证（spike #2）**
- `adapter.ts`：completion 请求改造（加 ref_file_ids 字段）
- `router.ts`：识别 vision + image 触发 pipeline

### 4.4 File Upload API（待 spike #2 验证）

需要逆向 `chat.deepseek.com` 的 file upload 接口。**待 spiking**：
- 端点路径（推测 `/api/v0/files/upload` 或 `/api/v0/upload`，**待验证**）
- 请求方法（POST multipart/form-data？）
- 是否需要 pow challenge（completion 端点需要，file upload 待验证）
- file_id 格式（推测 `file_xxx` 字符串）

实现参考：`/tmp/llmweb2api/client.ts:uploadImageFile` + `pollFileReady`（已下载到本地的参考文件）。

---

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/background/vision-pipeline.ts` | **新增**：image 抽取 + file upload + 消息重写 |
| `src/background/providers/deepseek/client.ts` | 新增 `uploadFile(token, bytes, mime)` + `pollFileReady(token, fileId)` |
| `src/background/providers/deepseek/adapter.ts` | `completionPayload` 加可选 `ref_file_ids` 参数 |
| `src/background/router.ts` | 触发 vision pipeline（v0.1.66 拒绝 array content → 改为 vision-only 例外） |
| `tests/unit/vision-pipeline.test.ts` | **新增**：dry-run 测试（mock fetch + upload） |
| `tests/integration/router.test.ts` | vision + array content 集成测试 |
| `src/shared/api-types.ts` | `Message.content` 类型扩展：`string \| ContentBlock[]` |
| `docs/01.memory.md` | vision multimodal 修复链经验 |

---

## 6. 测试策略

### 6.1 单元测试（dry-run）

- `extractImageRefs`：data URL / HTTP URL / 混合 / 无 image / 错误格式
- `renderMessageWithImage`：text 保留 / image_url 替换 `[image]` / 空 content
- `uploadFile` (mock fetch)：成功 / 401 / 5xx / 网络错误
- `pollFileReady`：轮询完成 / 超时 / 中间失败

### 6.2 集成测试

- router + vision pipeline + mock adapter
- 真实 token 路径走 spike（用户协助，token 不入仓）

### 6.3 端到端验证

- spice 端 agent 调 vision 模型 + 图片，电路图查图流程
- sseRaw 中 `model_type: "vision"` + `ref_file_ids` 存在
- replySample 是 vision 模型直接对图片的回复（不是 side-session OCR）

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| file upload API 未文档化，可能变动 | 完整端到端测试 + 错误捕获，必要时回退到 side-session 模式 |
| pow challenge 在 file upload 上行为未知 | spike #2 验证；如需要，pow 模块已存在 |
| 大图片 base64 编码开销 | v1 不优化；可观察真实场景体积 |
| 临时文件残留 | 不主动清理；观察 DeepSeek 服务端 TTL 行为，超限再调 |

---

## 8. 不做（v1 范围外）

- ❌ 同图 hash 缓存
- ❌ 多图并发上传（串行上传足够，deep.api 非吞吐敏感）
- ❌ 官方 OpenAI API 接入（保持单一 provider）
- ❌ vision + 多轮对话的图片持久化（v1 每次请求独立传图）
- ❌ side-session OCR fallback（实测有需求再加）

---

## 9. 实现顺序

1. spike #2（实现验证）：写 upload file API 探测脚本（Node + 用户 cookie），确认端点 / 鉴权
2. spike #2 → 落 spec 调整（如果 file upload 跟预期差异大）
3. worktree：vision-pipeline + adapter + router + tests
4. 集成测试 + 端到端（spice 端电路图场景）
5. 提 PR → merge → bump version