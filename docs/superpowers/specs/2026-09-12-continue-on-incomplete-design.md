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

**成功标准**：客户端视角为**一条连续流**——无重复、无缺口、正常 `finish_reason` 收尾（段间停顿 ≥ `CONTINUE_DELAY_MS` + 请求往返，可见但可忽略）。

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
3. wrapper 已持有本轮 response message id（ready 事件给过，即 F3 的续接目标；wrapper 自持 `currentMessageId`，不依赖消费侧写时序，见 §3.3/§3.4）；
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

- **计数器**：`run.emittedThinkChars` / `run.emittedContentChars` 按**当前 response message** 累计已发出的**原始**字符数（`think_delta`/`content_delta` 的 `content.length`，先于消费侧 DSML 归一化）。由**续接 wrapper（§3.4，单点）**在事件流经时统一累加——两条消费路径零改动，口径天然一致；
  - **per-message 而非 per-request**：wrapper **自持 `currentMessageId`**（事件流经时就地记录 `ev.id` 后比较，**不依赖消费侧写 `run.parentMessageId` 的时序**），新 id ≠ 自持值时**清零**计数。fallback 降级换 message 后，下一次续接的 skip 必须只含新 message 的已发字符，否则会把新消息的快照内容整段吞掉（缺口）；
  - **为何必须用原始数**：快照重发的是服务端原始文本流；断流时 DSML 归一化器可能扣着一段未 emit 的尾部缓冲（如收到 `"abc<"`，emit 了 `"abc"`、缓冲了 `"<"`）。按原始数（4）裁剪后，续接流补齐的恰是缓冲所缺的后续字符（`"tool_calls>…"`），归一化器缓冲（`"<"`）+ 新输入 = `"<tool_calls>…"`，与单条连续流完全等价；若按可见数（3）裁剪，快照会重发 `"<tool_calls>…"`，与缓冲拼成 `"<<tool_calls>…"`，归一化输出错乱。**本口径为最终裁决**——`.research/spike-design.md` 末尾旧表述（「扣住未发的字符不算已发」）作废；
- parser 的 `makeProcessor` 接收 skip（`{thinkingChars, responseChars, expectMessageId?}`），**只裁剪来自快照（`applySnapshot`）事件的内容**：
  - 快照内容 ≤ skip → 整段吞掉，不 emit；快照内容 > skip → 裁掉 skip 长度，余下 emit（覆盖「服务端多生成了但未送达」的边界，天然补齐）；skip 归零后不再裁剪；
  - **裁剪只作用于事件内容，不参与状态判定**：`if (snap.length > 0)` 必须用**裁剪前**的原始数组长度判断——「快照恰被全部吞掉」是本设计的**正常情形**（F5），若用裁剪后长度判断，`snapshot:fragments` / `lastPath` / `lastOp` 不会设置，紧随的简写增量（形态 2）会落进 unknown 兜底被**静默丢弃**；
- **不裁剪追加增量（appends）**：appends 即新内容，直接放行；快照结束后残余 skip 计数**丢弃**，不作用于 appends。前提：该流的首个内容帧带 `p` 或已有前序帧建立 `lastPath`（与现有 parser 行为一致；无快照且首帧即纯简写时按现状丢弃，不新增兜底）；
- 裁剪**不影响 `ResponseTree.fragments` 状态**——后续 `response/fragments/-1/content` 增量照常接在最后一个 fragment 上（每个续接段都是新 parser/新 tree，快照不会双推 fragment）；
- **fallback 降级保护**：若续接段 ready 的 `response_message_id` ≠ 请求的 `message_id`（`fallback_to_resume` 降级新建了另一条消息，未观测），该段**禁用裁剪**——宁可重复也不吞内容（新消息的快照可能不含旧内容）。实现 fail-safe：`allowTrim = readySeen && readyId === expectMessageId`（ready 未出现 / id 非 number / 快照先于 ready → 一律不裁）；
- skip 按 fragments **顺序**消费（服务端 append-only，两轮抓包一致）：同类型多 fragment 依序扣减，不跨类型、不重排；

**已知限制**（记录，不处理）：若同一次续接流中出现**第二次快照重发**，skip 已耗尽，可能重复该次快照内容。两轮抓包均只有一次快照，暂不引入内容指纹比对（复杂度不成比例）。

### 3.4 续接循环与收敛

**单点实现：续接循环放进 `runExclusiveStream` 的锁内**（`run` 等状态经参数传入）——消费侧（非流式 / 流式两路）零改动、口径天然一致，且**锁覆盖续接窗口**：

```
签名：runExclusiveStream(provider, ctx, req, run, afterLock?)   // run 由调用点（router.ts:375 已有变量）传入

  let release = await locked
  try {
    if (afterLock) {                          // 现有 N3 换锁逻辑，原样保留（持旧锁等新锁会死等）
      const key0 = `${req.session.providerId}:${req.session.webSessionId}`
      await afterLock()
      const key1 = `${req.session.providerId}:${req.session.webSessionId}`
      if (key1 !== key0) { release(); release = await queue.acquire(key1) }
    }
    let currentMessageId = run.parentMessageId   // wrapper 自持，不依赖消费侧写时序（§3.3）
    for await (const ev of src) {             // src = streamWithRetry(首段)
      // wrapper 拦截：message_id 事件时（新 id ≠ currentMessageId）更新自持值并清零计数；
      // stream_stats 就地累计改写（§3.7）
      yield ev
    }
    while (可续接) {                           // run.streamError + §3.1 条件（含 continueStream 存在性）；锁仍持有
      run.streamError = undefined
      run.continueAttempts++
      await sleep(CONTINUE_DELAY_MS)           // 500ms，避免对故障服务端追击
      yield* provider.continueStream(ctx, req.session, currentMessageId,
                                     { thinkingChars: run.emittedThinkChars, responseChars: run.emittedContentChars })
    }
  } finally { release() }
```

- **锁覆盖续接窗口**：续接期间同 session 的并发请求拿不到锁（named cid 的 `decide` 不查 busy，唯一保护就是队列锁）；代价是续接窗口占用一个全局并发槽位（与长流占位同理）；
- 续接段再次断流 → 回到循环（attempts 递增）；达到上限仍失败 → 既有的流末 503 检查（`if (run.streamError) throw err('provider_unavailable', …)`，消费侧保留）触发；
- **续接段成功判据（进展要求）**：带 skip 的续接段在流末若 `lastStatus`/`lastQuasi` 均为 null（空 200 / 非 SSE / 无终态断连）→ parser 合成 `stream_error('resume ended without terminal status', 'incomplete_status')`，计为失败走重试/上限——否则「200 空响应」会被当成功，产生 silent 截断（与 v0.2.2 修的同类 bug）。首段（无 skip）不受此约束，行为不变；
- 续接请求本身抛错（网络/HTTP）→ 直接传播（不再叠加重试）；
- 成功后：聚合内容包括全部续接段，`commit`/mirror/日志与正常路径完全一致（一次性 commit）。

### 3.5 实现挂点

| 文件 | 改动 |
|---|---|
| `src/background/providers/deepseek/sse-patch.ts` | `completionEvents(body, timeoutMs, onReady, skip?)`；`makeProcessor` 持有 skip 剩余量（`{thinkingChars, responseChars, expectMessageId?}`），快照分支**只裁剪事件内容、不改 path/lastPath/lastOp 状态**（§3.3）；`allowTrim = readySeen && readyId === expectMessageId`（fail-safe）；带 skip 的流末无终态 → 合成 stream_error（§3.4） |
| `src/background/providers/deepseek/client.ts` | 新增 `continuePayload(session, messageId)` → `{chat_session_id, message_id, fallback_to_resume: true}`；新增 `continueHeaders(token)`（`baseHeaders` + x-client 指纹，无 PoW） |
| `src/background/providers/deepseek/adapter.ts` | 新增 `continueStream(ctx, session, messageId, skip)`——请求 `fetchStreamSafe('/chat/continue', …)`（**不带 `/api/v0` 前缀**，base 已含，参照 `FILE_FETCH_PATH` 双前缀事故史）；`continueHeaders` 头无 PoW；复用 `completionEvents`；`withPowHeaders` 改为 `continueHeaders` + PoW 头 |
| `src/background/providers/adapter.ts` | `ProviderAdapter` 接口 + `continueStream` 签名 |
| `src/background/router.ts` | `RunState` 加 `continueAttempts` / `emittedThinkChars` / `emittedContentChars`；**续接循环进 `runExclusiveStream` 锁内**（单点；wrapper 拦截事件做 per-message 计数与 stream_stats 累计改写）；消费侧仅保留既有流末 503 检查；`done()`/LogEntry 带 `continueAttempts`；新增常量 `MAX_CONTINUE_ATTEMPTS=3` / `CONTINUE_DELAY_MS=500` / `RESUMABLE_REASONS` |
| `src/background/log.ts` + `src/popup/snippet.ts` | `LogEntry.continueAttempts?: number`（诊断：实际续接了几次）+ 加入 `FORENSIC_FIELDS` 取证白名单 |
| 测试 | 见 §4 |

`consumeEvent` / `encodeStream` **不做续接相关改动**（wrapper 在流源侧单点完成）；`chunk-encoder` 无改动（续接事件与普通事件同形）。

### 3.6 取消语义

流式 `cancel()` 仍走现有 `stopStream`（best-effort，`message_id` 取当前 `run.parentMessageId`）。续接进行中取消 → generator return → 底层迭代器关闭（现有机制），无新增语义。

### 3.7 诊断

- `LogEntry.continueAttempts`：本次请求实际续接次数（成功并入也算）；
- `stream_stats` 由 wrapper **就地改写为全程累计语义**（每段到达时改写，不推迟到流末——cancel/中断也有现场；消费侧仍是直接赋值，零改动）：`statusValues` 按段拼接（如 `['INCOMPLETE','FINISHED']`）、`bytes` 求和、`paths` 并集、`thinkingChars`/`responseChars` 求和（累计值，不再是段级）、`rawTail` 取最后非空段（全部失败时即最后的坏段现场）；**同一事件上的其余字段必须原样保留**：`rawSample` 取首段非空（累计后不改写）、`autoResume`/`hasPendingFragment` 取最后有值段——否则 `sseRaw`/`sseAutoResume`/`sseHasPendingFragment` 会从**所有**日志（含无续接的回归场景）静默消失；
- 失败且未续接时行为与 v0.2.2 完全一致（含 `sseRawTail` 现场）。

---

## 4. 测试计划（TDD，先失败后实现）

**单元（sse-patch）**：

1. skip 裁剪：快照重发旧内容（think=10 / content=4），skip 恰等 → 快照零 emit，appends 正常 emit；且简写增量（形态 2）不因「快照被全吞」而丢帧（`lastPath/lastOp` 已按裁剪前快照设置，paths 无 `unknown:v`）；
2. 部分送达补齐：skip content=2，快照 "Both" → emit "th"；
3. 无快照的续接流：skip 不消耗，带 `p` 的 appends 原样 emit（防误裁）；首内容帧即纯简写（无 lastPath）按现有 parser 行为丢弃——与单流一致；
4. fallback 保护（fail-safe）：`expectMessageId` 不匹配 / ready 未出现 → **不裁剪**（全量 emit）；匹配 → 正常裁剪；
5. 续接段终态要求：带 skip 的流末 `lastStatus/lastQuasi` 均 null → 合成 stream_error；出现 FINISHED → 无错误事件；
6. 回归：skip 缺省（正常 completion）行为与现状完全一致——含「skip 缺省 + 无终态 → **不**合成 stream_error」（首段行为不变，防实现把终态要求错误地扩大到所有流）。

**单元（client）**：`continuePayload` 字段形状 + `continueHeaders` 无 PoW（对照抓包）。

**单元（deepseek-adapter）**：`continueStream` 请求打到 `/chat/continue`（断言 fetch 的 path，**无双前缀**）、无 `X-Ds-Pow-Response`、SSE 事件接线正确。

**集成（router + stub adapter）**：

7. fail-to-pass：首段 stream_error → `continueStream` **委托真实 `completionEvents`** 消费自洽合成的续接 SSE（快照重发 + 显式 `p` 首帧 + 简写 + BATCH/status）→ 单次成功；断言客户端可见内容**逐字**等于「首段 + 续段新增」、`continueAttempts=1`、log 里 `continueAttempts=1`、`sseStatusValues=[INCOMPLETE, FINISHED]`；
8. 连续两次断流 → 两次续接成功（attempts=2）；
9. 三次续接仍 stream_error → 503（上限收敛）；
10. `unsupported_client_by_model` → **不调用** continueStream，直接 503；
11. stream:true 路径同 7（分块连续、无重复、正常 finish chunk）；
12. 回归：正常流零续接（continueStream 不被调用）；单段请求 log 的 `sseRaw`/`sseAutoResume`/`sseHasPendingFragment` 与改动前逐字段一致（守 §3.7 的 stats 合并不得丢字段）；
13. **DSML 跨段对齐**：首段以 `"abc<"` 断流（`<` 被归一化器扣住），续接段续上 `"tool_calls>…"`；断言 `continueStream` 收到的 `skip.responseChars === 4`（原始数，而非可见数 3），最终客户端内容无重复、标记归一化正确；
14. 未拿到 message_id（ready 前即断流）→ 不调 continueStream，直接 503；
15. **fallback 换 message 的 skip 基线**：首段 msg4 断流 → 第 1 次续接 ready id=5（该段禁用裁剪）发出部分内容后再断流 → **第 2 次续接收到的 `skip` 只计 msg5 已发字符**（断言记录下来的 skip 数值，而非只看最终文本——「漏清零」只会多吞快照，而 appends 不被裁，常规构造下两种实现输出逐字相同）；fixture 让 msg5 快照**长于**其已发字符（服务端多生成未送达），漏清零实现会把尾部一并吞掉，断言可直接观察到缺口；
16. **空续接不假成功**：续接返回 200 空流 → 计失败，attempts 用尽后 503（不是 `finish_reason=stop` 的部分回复）。

**合成 fixture 说明**：`.research/spike-design.md` 的抓包原文是**省略稿（含 `…`）**，只能作形态依据，不能直接当字符级 fixture；测试用**自洽合成**的 SSE（字符数与断言严格对齐）。

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
| 续接段 200 空响应/无终态被当成功（silent 截断） | §3.4 进展要求：带 skip 的续接段无终态即合成 `stream_error` 计失败，attempts 用尽报 503；用例 16 |
| 续接期间服务端 fallback 降级新建 message（id 变化） | ready 的 `response_message_id` 更新 `run.parentMessageId`（后续段与 commit 跟随）+ 该段**禁用 skip**（§3.3）+ 换 message 时**计数清零**（per-message skip 基线）；用例 15 |
| 续接窗口内同 session 并发 | §3.4 锁覆盖续接窗口（wrapper 在 `runExclusiveStream` 锁内）；named cid 的 `decide` 不查 busy，靠队列锁串行；代价：续接窗口占用一个全局并发槽位 |
| 续接请求本身抛错（网络/HTTP） | 直接传播（§3.4）：该次 attempt 已计数，但剩余预算不再使用，错误按既有 mapErr 映射（429/503）——在已收到部分内容后会得到错误而非静默截断，对客户端仍诚实 |
| 带 skip 段无终态=失败 的残余误报面 | 内容完整但服务端不给任何 status 帧的续接段会被判失败（有重试时通常自愈）；两轮抓包续接段终态均正常 FINISHED，无此形态证据；message 文本区分（`resume ended without terminal status`）便于日志判读 |

---

## 7. 验收标准

1. 用一个可复现断流的真实场景（或 stub 注入）验证：客户端收到完整内容，无重复、无 503；
2. `bun run test` 全绿（含 §4 全部新用例）；`bun run build` 通过；
3. 版本 bump（当前 v0.2.7 → 下一个 z+1）；
4. 日志可读：`continueAttempts` 与实际相符。

---

## 8. 实施顺序（供 writing-plans）

1. parser skip + 终态要求（含 §4 单测 1-6）；
2. client `continuePayload`/`continueHeaders` + adapter `continueStream`（含单测）；
3. router 续接循环（`runExclusiveStream` 锁内，含 §4 集成用例 7-16）；
4. 日志字段 + bump/build + 手测验收。
