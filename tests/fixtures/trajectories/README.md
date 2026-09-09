# Trajectory Fixtures（fix/trajectory-fixture，2026-09-09）

> 2026-09-09（用户上轮要求 + 上上轮要求）：把 popup 日志形态的「实测轨迹」落成 fixture，用重放测试在后续改动中做回归保护。

## 目的

- **回归保护**：deep.api 链路（mirror / decide / persist / 持久化）改动时，能跑通历史实测轨迹，断言每条 entry 的 `action / threadFound / mirrorPrefixOk / deletedOld / finishReason / parentMessageId / webSessionId` 与真实日志一致
- **真实场景**：stub adapter 只能给出「行为」，但真实 spice chat session 里 LLM 的实际响应结构（asst tool_calls 顺序、tool_call_id、arguments 嵌套引号等）会影响 commit 的 mirror 内容。fixture 锁定这些「场景指纹」
- **新增测试方向**：每个新 bug 真实轨迹可加 fixture 防止回退

## 文件格式

每条 `*.jsonl` 一个「线程轨迹」—— 一系列按 spice 时序发到 deep.api 的 create 请求。

每行一个 entry（一个 create 请求 + stub LLM 事件 + 期望 log）：

```jsonc
{
  "label": "turn1-rebuild",        // 描述性标签（test 输出可读）
  "request": {                      // 直接传给 Router.create 的请求
    "model": "deepseek-v4-flash",
    "messages": [{"role":"user","content":"..."}],
    "conversation_id": "cid-xxx",
    "stream": true                   // 可选，默认 false
  },
  "stub": {                         // LLM 响应事件（流式或聚合）
    "events": [                      // 顺序 emit，每个元素是 ProviderStreamEvent
      {"kind":"message_id","id":1},
      {"kind":"content_delta","content":"hi","finish_reason":"stop"}
    ],
    "aggregate": {                   // 非流式（stream=false）时直接给聚合结果
      "content":"hi","finishReason":"stop"
    }
  },
  "expectLog": {                    // 断言当条 create 后 LogEntry 的关键字段
    "action": "rebuild",             // 或 "incremental"
    "threadFound": false,
    "mirrorPrefixOk": false,
    "deletedOld": false,
    "finishReason": "stop",
    "msgsLen": 2                     // 创建请求带的 messages 数（推断用）
  }
}
```

> **流式**（`request.stream=true`）：用 `stub.events` 序列。
> **非流式**（默认）：用 `stub.aggregate`，router.finalize 一次性收到聚合。

## 使用

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
const lines = readFileSync(join(__dirname, '../fixtures/trajectories/thread-persistence.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse);
```

每个 line 跑一次完整链路（含 stream 消费），断言 expectLog。

## 已知 fixture

- `thread-persistence.jsonl`：rebuild + incremental 两点最小集（来自用户 v0.1.53 一条实测 cid=mttkjhe0-c5ae 的前两条日志）。证明数据层持久化后第二轮能续聊同一 DeepSeek 会话

## 添加新 fixture

1. popup 复制一段完整日志 JSON
2. 提取该 cid 的每条 entry
3. 把 `messagesFull` 拆成 `messages` 数组
4. 用 messagesSample 末尾的 `<tool_calls>` 文本（如果有）作为 `stub.events` 里的 content_delta
5. 给 `expectLog` 填当条日志的 action / threadFound / mirrorPrefixOk / deletedOld / finishReason / msgsLen
6. 重跑测试验证

## 与 deep.api 其它测试的关系

- `tests/unit/`：mapper / log / queue 等纯逻辑
- `tests/integration/`：Router + stub adapter 端到端
- `tests/replay/`（本目录）：**真实用户轨迹**回归保护。fixture 是「场景快照」，不是单元测试参数
