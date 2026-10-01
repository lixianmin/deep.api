# 2026-09-12 禁止无工具调用的行动宣言（instruction 硬化）

## 背景

spice trace `spice-a0ff0206`（09-12 钢琴任务）：用户确认开工后，模型输出
「Now I'll rewrite the sketch…」纯宣言、零工具调用、干净收尾，spice 侧 agent 停摆。
桥侧现状：

- `tool-pipeline.ts` instructionBlock 的 `auto` 分支教模型『当需要工具时调用；可以零次
  或多次调用；最后给出一段自然语言总结』——纯文本收尾永远是合法形态，宣言体收尾无约束。
- v0.2.8 `continue-on-incomplete` 只接**断流**（`run.streamError` + RESUMABLE_REASONS），
  模型干净收尾不触发。
- 09-15/后续的 tool-call-recovery 层管「有工具块但格式漂移」，管不了「压根没有块」。

**职责定位**：本仓不是纯 OpenAI 兼容代理，而是协议转换器——后端是 `chat.deepseek.com/api/v0` 网页会话接口逆向（无 tools 参数、有状态 thread、PoW），OpenAI `tools` 无法透传，`<tool_calls>` 文本协议是本仓发明的仿真层。因此工具调用格式规约（含「何时可以不带工具块收尾」）只能由本仓的 promptSuffix 定义；spice harness 刻意协议盲（工具广告只走 tools 参数，见 spice 仓 09-12 决策）。本 spec 是协议发明者完善自己的规约，不是替 harness 管行为——行为层强制（宣言后不执行则自动续跑）归 spice 仓 auto-nudge（其 spec `2026-09-12-agent-stall-autonudge-design.md`）。

**职责划分**：循环续跑（自动 nudge）归 spice harness（loop 在 spice 侧，见其 spec
`2026-09-12-agent-stall-autonudge-design.md`）；本仓只做协议层减噪——降低宣言体收尾
的发生频率，不承诺根除。

## 修法

`src/background/tool-pipeline.ts` `buildToolPrompt` 的 `auto` 分支 instruction 追加一句
硬约束（措辞与既有风格一致，大意）：

> 不允许只输出行动计划或宣言（如「我现在去改代码」「接下来我会更新电路」）而不携带
> `<tool_calls>` 块——要行动就在同一条消息里给出 `<tool_calls>`；不携带工具块的纯文本
> 只允许两种：最终总结，或向用户提问。

`required` 分支已有等价约束（「不允许只给出纯文本回答」），不动。

## 空工具调用块（`<tool_calls></tool_calls>`，同日追加）

**现场**：spice trace #260——模型输出空调用块 + 幻觉正文。旧路径：块体无 invoke/parameter
标记 → 命中流式归一化器的「散文提及」豁免（fix/dsml-no-silent-leak）→ 原样透传 →
污染 spice 端 LLM 上下文（few-shot 教模型模仿残缺形态）。

**修法（dsml-parser.ts 归一化器）**：配对（有匹配闭标签）且块体为空白 → 丢弃，记录进
`dropped`（诊断用，不透传）。理由：块体为空证明零信息损失，丢弃不违反「不静默丢调用」
原则（没有调用可丢）；配对本身证明不是散文引用。

**边界**：① DSML 形态空块（带命名空间标记）仍走 `unparsed` → repair（行为不变）；
② 未配对的散文提及（如「用 <tool_calls> 标签收尾」）豁免不变；③ **不考虑 repair 重问**：
空块的行为学矫正（要么真调工具要么诚实说不能）归 spice harness 的 auto-nudge，桥重问
多一跳往返且失败即 400 断链，收益不成比例；④ 代码围栏内的示例空块也会被丢弃（归一化
器无围栏感知）——已接受的已知取舍，出现成本是文档示例缺一角，远低于泄漏成本。

## 测试计划（TDD）

1. fail-to-pass：tool-pipeline 单测断言 `auto` 的 promptSuffix 含「宣言/不带工具块」
   约束关键句（fixture 用 trace #275 原句形态）。
2. pass-to-pass：既有 tool-pipeline 快照/契约测试不回归；`required` / `none` 分支不变。
3. 空块（同日追加）：dsml-parser 归一化器 5 用例——配对空块丢弃+`dropped` 记录 /
   delta 切断不泄漏 / 散文提及豁免不回归 / DSML 空块仍走 unparsed / 空块与真实块并存。

## 验收

`bunx vitest run`（或仓内既有 runner）全绿；扩展加载无回归（demo debug 页冒烟）。
worktree 流程按本仓 AGENTS.md §13。

## 明确不做

- 不在桥做「无标签自动续问」：那是 agent 循环职责，桥的重问只保留给既有 repair 层
  管的格式漂移场景，两层同时重问会互相打架。
- 不动 `router.ts` 「无标签 = 合法 stop」的传输语义——协议上它必须合法（总结/提问
  都是纯文本收尾）。
