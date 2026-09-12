# 断流自动续接 — DeepSeek 网页 `/chat/continue`

**日期**：2026-09-12
**状态**：草案，待 user review
**触发**：DeepSeek 网页生成中途断流时 UI 显示 Continue 按钮，需用户手动点击才能继续；deep.api 应自动续接（客户端视角：一条连续流）
**前置**：v0.2.2 已消除 silent bug（识别断流信号并报 503，见 memory「DeepSeek 网页断流信号」）；本 spec 在其上把「报错」升级为「自动恢复」

---

## 1. 目标

当生成中途断流（`response/status=INCOMPLETE` / `generation_err` 等）时：

1. deep.api 自动调 `POST /api/v0/chat/continue` 续接，把续接内容**无缝并入同一条流**（无重复、无缺口）；
2. 续接成功后正常 `finish_reason` 收尾（工具调用等后处理与正常路径完全一致）；
3. 续接仍失败（服务端持续故障）→ 达到上限后维持 v0.2.2 行为报 503。

**成功标准**：客户端视角为**一条连续流**——无重复、无缺口、正常 `finish_reason` 收尾（段间有 ≤500ms 停顿，可见但可忽略）。

---

## 2. 实测事实（两轮抓包 + v0.2.1 埋点，均为用户真实环境）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 断流信号：`{"p":"response/status","o":"SET","v":"INCOMPLETE"}` + 独立 error 帧 `{"type":"error","content":"Server is temporarily unavailable.","finish_reason":"generation_err"}`（Pro 旧案 `unsupported_client_by_model` 同形） | 第一轮 incident 抓包（rawTail 逐帧）→ v0.2.2 已实现检测 |
| F2 | 续接端点：`POST /api/v0/chat/continue`，body `{"chat_session_id":"<uuid>","message_id":<int>,"fallback_to_resume":true}`；**无 PoW 头**、无 prompt/model_type/parent_message_id | 两轮抓包（用户 DevTools curl） |
| F3 | `message_id` = 断流那条 ready 事件的 `response_message_id` = deep.api 的 `run.parentMessageId` | 第二轮抓包：请求 `message_id:4`，ready `response_message_id:4`，快照 `message_id:4` |
| F4 | 响应流与 completion **同构**：`event: ready` → 快照 `{"v":{"response":{…"fragments":[…]}}}` → `p/o/v` 增量 + 简写 → BATCH/status 帧 → 终态；同一个 `completionEvents` parser 可直接复用 | 第二轮抓包响应全文 |
| F5 | **快照重发全部既有 fragments**（含断流前已发出的 THINK 全文 + RESPONSE 已生成文本），之后才追加新内容 | 第二轮抓包：快照含 `THINK "Now compile. …"` + `RESPONSE "Both"`，随后追加 `" files"`… |
| F6 | 续接的 ready `response_message_id` = 原 message id（同一条消息续写；`fallback_to_resume` 允许服务端降级新建，届时 id 变化） | 第二轮抓包 |
| F7 | usage 是整条消息的累计值（13634 → 13677），不是续接增量；`auto_resume:false` 不决定 UI（网页实测仍出 Continue 按钮） | 两轮抓包 |
| F8 | 续接流终态正常 `FINISHED`（无 error 帧） | 第二轮抓包 |

---

## 3. 设计

### 3.1 触发条件（两路共用）

流段（completion 或续接段）耗尽后，若同时满足：

1. `run.streamError` 存在（v0.2.2 的断流信号）；
2. `run.streamError.reason ∈ RESUMABLE_REASONS`（`generation_err` / `incomplete_status`）——永久错误（如 `unsupported_client_by_model`）不续接；
3. `run.parentMessageId !== null`（本轮 ready 事件已给出 response message id，即 F3 的续接目标）；
4. `run.continueAttempts < MAX_CONTINUE_ATTEMPTS`（默认 3：最多发起 3 次续接请求；3 次都失败则报错）。

→ 发起续接；否则走现有 503 路径（v0.2.2 行为不变）。

实现层补充：`provider.continueStream` 在接口中为**可选方法**（与 `uploadFile`/`pollFileReady` 同例）——未实现它的 provider/stub 不参与续接（router 先检查存在性），避免破坏既有 4 个测试文件的 stub adapter。

### 3.2 续接调用（adapter 层）

`ProviderAdapter` 新增方法（跟在 `streamCompletion` 旁）：

```ts
continueStream?(ctx: ProviderContext, session: ProviderSession, messageId: number | string,
                skip: { thinkingChars: number; responseChars: number }): AsyncIterable<ProviderStreamEvent>;
```

- 请求：`POST /chat/continue`，body `{chat_session_id: session.webSessionId, message_id: messageId, fallback_to_resume: true}`（F2）；
- headers：`baseHeaders` + `x-client-*` 指纹（与 completion **现有值**相同，**不调 PoW**）——抓包同款；网页已用 2.5.0 而 deep.api 仍 2.4.0 的版本漂移是另一个 follow-up，不在本 spec 范围；
- 响应：`fetchStreamSafe` 校验 200 后，`completionEvents(res.body, NO_PROGRESS_MS, onReady, { ...skip, expectMessageId: messageId })`（F4；`expectMessageId` 供 fallback 降级时关闭裁剪，见 §3.3）；

### 3.3 内容合并（skip 裁剪，本设计核心）

**问题**（F5）：续接快照重发断流前已发出的内容。若直接转发，客户端收到重复文本。

**方案**：

- router 按**原始增量**累计已发出字符数（`run.emittedThinkChars` / `run.emittedContentChars`，在 `consumeEvent` 与 `encodeStream` 两路、**先于 DSML 归一化**的 `think_delta`/`content_delta` 上累加）；续接时把这两个数作为 `skip` 传入。
  **为何必须用原始数**：快照重发的是服务端原始文本流；断流时 DSML 归一化器可能扣着一段未 emit 的尾部缓冲（如收到 `"abc<"`，emit 了 `"abc"`、缓冲了 `"<"`）。按原始数（4）裁剪后，续接流补齐的恰是缓冲所缺的后续字符（`"tool_calls>…"`），归一化器缓冲（`"<"`）+ 新输入 = `"<tool_calls>…"`，与单条连续流完全等价；若按可见数（3）裁剪，快照会重发 `"<tool_calls>…"`，与缓冲拼成 `"<<tool_calls>…"`，归一化输出错乱；
- parser 的 `makeProcessor` 接收 skip 参数，**只裁剪来自快照（`applySnapshot`）的事件**头部字符：
  - 快照内容 ≤ skip → 整段吞掉，不 emit；
  - 快照内容 > skip → 裁掉 skip 长度，余下 emit（覆盖「服务端多生成了但未送达」的边界，天然补齐）；
  - skip 归零后不再裁剪；
- **不裁剪追加增量（appends）**：若某次续接流不带快照（未观测），appends 即新内容，直接放行，无吞字风险；快照结束后残余 skip 计数**丢弃**，不作用于 appends；
- 裁剪只影响 emit 的事件，**不影响 `ResponseTree.fragments` 状态**——后续 `response/fragments/-1/content` 增量照常接在最后一个 fragment 上；
- **fallback 降级保护**：若续接段 ready 的 `response_message_id` ≠ 请求的 `message_id`（服务端 `fallback_to_resume` 降级新建了另一条消息，未观测），**该段禁用裁剪**——宁可重复也不吞内容（新消息的快照可能不含旧内容，盲目按字符数裁剪会吃掉新内容）。实现：parser 的 skip 带 `expectMessageId`，ready id 不匹配即关闭裁剪；
- skip 按 fragments **顺序**消费（服务端 append-only，两轮抓包一致）：同类型多 fragment 依序扣减，不跨类型、不重排；

**已知限制**（记录，不处理）：若同一次续接流中出现**第二次快照重发**，skip 已耗尽，可能重复该次快照内容。两轮抓包均只有一次快照，暂不引入内容指纹比对（复杂度不成比例）。

### 3.4 续接循环与收敛

```
非流式 / 流式路径的事件消费循环改为消费「包装 generator」：

  yield* handle.stream                          // 首段
  while (可续接) {                               // run.streamError + §3.1 条件
    run.streamError = undefined                  // 清信号，准备重试
    run.continueAttempts++
    await sleep(CONTINUE_DELAY_MS)               // 500ms，避免对故障服务端追击
    yield* provider.continueStream(ctx, session, run.parentMessageId,
                                   { thinkingChars: run.emittedThinkChars, responseChars: run.emittedContentChars })
  }
  // 循环后再检查：仍有 streamError → 抛 503（v0.2.2 行为）
```

- 续接段再次断流 → 回到循环（attempts 递增）；
- 达到上限仍失败 → `err('provider_unavailable', …message…)` 503；
- 续接请求本身抛错（网络/HTTP）→ 直接传播（不再叠加重试）；
- **不走队列锁**：续接发生在 provider 流已耗尽之后（`runExclusiveStream` 的 finally 已释放锁），直调 `provider.continueStream`——与 `repairToolCalls` 直调 `streamCompletion` 同例；续接窗口内同线程并发由 mapper 的 busy 标记兜底（`decide` 跳过 busy 的 auto 线程），与 repair 的风险面相同；
- 成功后：聚合内容包括全部续接段，`commit`/mirror/日志与正常路径完全一致（一次性 commit）。

### 3.5 实现挂点

| 文件 | 改动 |
|---|---|
| `src/background/providers/deepseek/sse-patch.ts` | `completionEvents(body, timeoutMs, onReady, skip?)`；`makeProcessor` 持有 skip 剩余量（`{thinkingChars, responseChars, expectMessageId?}`），快照分支裁剪后 emit；ready id ≠ `expectMessageId` 时禁用裁剪 |
| `src/background/providers/deepseek/client.ts` | 新增 `continuePayload(session, messageId)` → `{chat_session_id, message_id, fallback_to_resume: true}`；新增 `continueHeaders(token)`（`baseHeaders` + x-client 指纹，无 PoW） |
| `src/background/providers/deepseek/adapter.ts` | 新增 `continueStream(ctx, session, messageId, skip)`（`continueHeaders` 头，无 PoW；复用 `completionEvents`）；`withPowHeaders` 改为 `continueHeaders` + PoW 头 |
| `src/background/providers/adapter.ts` | `ProviderAdapter` 接口 + `continueStream` 签名 |
| `src/background/router.ts` | `RunState` 加 `continueAttempts` / `emittedThinkChars` / `emittedContentChars`；两路的事件源包「续接 wrapper」（在既有 try/catch 内，续接请求抛错走统一错误映射）；流末 503 检查移到续接循环之后；`stream_stats.statusValues` 按段拼接；`done()`/LogEntry 带 `continueAttempts`；新增常量 `MAX_CONTINUE_ATTEMPTS=3` / `CONTINUE_DELAY_MS=500` / `RESUMABLE_REASONS` |
| `src/background/log.ts` + `src/popup/snippet.ts` | `LogEntry.continueAttempts?: number`（诊断：实际续接了几次）+ 加入 `FORENSIC_FIELDS` 取证白名单 |
| 测试 | 见 §4 |

两路（`consumeEvent` / `encodeStream`）的续接循环逻辑一致；`chunk-encoder` 无改动（续接事件与普通事件同形）。

### 3.6 取消语义

流式 `cancel()` 仍走现有 `stopStream`（best-effort，`message_id` 取当前 `run.parentMessageId`）。续接进行中取消 → generator return → 底层迭代器关闭（现有机制），无新增语义。

### 3.7 诊断

- `LogEntry.continueAttempts`：本次请求实际续接次数（成功并入也算）；
- `stream_stats`：`sseStatusValues` **按段拼接**（如 `['INCOMPLETE','FINISHED']` 一眼看出续接轨迹；全部失败时是多段 INCOMPLETE）；其余字段（bytes/paths/rawTail）**最后一段覆盖**（失败场景即最后的坏段现场；成功场景丢坏段现场，可接受）；
- 失败且未续接时行为与 v0.2.2 完全一致（含 `sseRawTail` 现场）。

---

## 4. 测试计划（TDD，先失败后实现）

**单元（sse-patch）**：

1. skip 裁剪：快照重发旧内容（think=10 / content=4），skip 恰等 → 快照零 emit，appends 正常 emit；
2. 部分送达补齐：skip content=2，快照 "Both" → emit "th"；
3. 无快照的续接流：skip 不消耗，appends 原样 emit（防误裁）；
4. fallback 保护：skip 带 `expectMessageId`，ready 的 id 不匹配 → 快照不裁剪（全量 emit）；匹配 → 正常裁剪；
5. 回归：skip=0（正常 completion）行为与现状完全一致。

**单元（client）**：`continuePayload` 字段形状 + 无 PoW 头组合（对照抓包）。

**集成（router + stub adapter）**：

6. fail-to-pass：completion 段 stream_error → continueStream 返回 FINISHED 段 → 单次成功响应，聚合内容 = 首段 + 续段（无重复，skip 生效）；
7. 连续两次断流 → 两次续接成功（attempts=2）；
8. 三次续接仍 stream_error → 503（上限收敛）；
9. `unsupported_client_by_model` → **不调用** continueStream，直接 503；
10. stream:true 路径同 6（分块连续、无重复、正常 finish chunk）；
11. 回归：正常流零续接（continueStream 不被调用）；
12. **DSML 跨段对齐**：首段以 `"abc<"` 断流（`<` 被归一化器扣住），续接段收到 `"tool_calls>…"`；断言 `continueStream` 收到的 `skip.responseChars === 4`（原始数，而非可见数 3），最终客户端内容无重复、标记归一化正确；
13. 未拿到 message_id（ready 前即断流）→ 不调 `continueStream`，直接 503。

**真实 fixture**：第二轮抓包的续接响应流（含快照重发 + appends + BATCH/status）作为 parser 测试输入。

---

## 5. 非目标

- 非「用户可选是否续接」——全自动（与网页 Continue 按钮语义一致）；
- 不改变正常 completion 路径；
- 不处理网络层断连/超时（无 `stream_error` 事件，抛出即报错，维持现状）；
- 不处理多快照重发的内容指纹比对（§3.3 已记录限制）；
- 不做跨请求持久化续接（同一 client 请求内的流内续接）。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| skip 字符数与服务端快照内容错位（服务端丢弃过部分内容） | skip 只作用于快照；最多吞/重少量字符（未观测）；真实 fixture 校准；日志可查 |
| `/chat/continue` 未来新增 PoW 要求 | 请求带 x-client 指纹、无 PoW；若 4xx/503 → 走续接失败路径报 503，日志可诊断；对齐新抓包更新 |
| 服务端持续故障 → 续接风暴 | 上限 3 次 + 间隔 500ms |
| 续接期间服务端 fallback 降级新建 message（id 变化） | ready 的 `response_message_id` 更新 `run.parentMessageId`（后续段与 commit 跟随）+ 该段**禁用 skip**（§3.3 fallback 保护）；正常路径（id 相同）不受影响 |
| 队列/并发：续接直调绕队列 | 与 repairToolCalls 同例（流已耗尽、锁已释放）；同线程并发由 mapper busy 与既有队列保护覆盖；不扩大既有风险面 |

---

## 7. 验收标准

1. 用一个可复现断流的真实场景（或 stub 注入）验证：客户端收到完整内容，无重复、无 503；
2. `npm test` 全绿（含 §4 全部新用例）；`npm run build` 通过；
3. 版本 bump（当前 v0.2.7 → 下一个 z+1）；
4. 日志可读：`continueAttempts` 与实际相符。

---

## 8. 实施顺序（供 writing-plans）

1. parser skip（含 §4 单测 1-5）；
2. client `continuePayload` + adapter `continueStream`（含单测）；
3. router 续接循环（两路，含 §4 集成用例 6-13）；
4. 日志字段 + bump/build + 手测验收。
