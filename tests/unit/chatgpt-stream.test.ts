/**
 * ChatGPT provider SSE 帧解释器测试。
 *
 * 夹具来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 * ——真实抓帧（18 帧 / span 6783ms / INCREMENTAL）。doc 中标 "{message 快照}" 的字段按 ChatGPT
 * 的实际消息结构填最小可信值（id/author/content），其余字段照抄 doc 文本。
 *
 * 本测试关注三件最易写错的事（doc §「解析规则」）：
 * 1. p/o 跨帧继承（只带 v 的帧必须沿用 state.lastP/lastO）
 * 2. p:""+o:"patch" 数组展开（数组内 append 与顶层同等处理）
 * 3. 通道分界（final_channel_token 之前 think_delta、之后 content_delta）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { interpretFrame, newStreamState } from '../../src/background/providers/chatgpt/stream';
import type { ProviderStreamEvent } from '../../src/background/providers/adapter';
import type { SseFrame } from '../../src/shared/chatgpt-sse';
import { splitFrames, parseFrame } from '../../src/shared/chatgpt-sse';

// ===== 真实抓帧（协议 doc §「SSE 帧协议」，逐帧照抄）=====
// 帧 3 / 帧 4 的 v 是 "{message 快照}"（doc 用占位符），填最小可信结构。
// 帧 12 / 帧 13 的 v 含 "..."（doc 用占位符），原样保留字面 "..."。
const REAL_RAW_FRAMES: string[] = [
  // 帧 1：delta_encoding + JSON 字符串 "v1"
  'event: delta_encoding\ndata: "v1"\n\n',
  // 帧 2：resume_conversation_token（顶层无 event 行；实参化 uuid/JWT）
  'data: {"type":"resume_conversation_token","conversation_id":"8f1b2c3d-4e5f-6789-abcd-ef0123456789","token":"eyJhbGciOiJIUzI1NiJ9.x.y"}\n\n',
  // 帧 3：add 消息快照
  'event: delta\ndata: {"p":"","o":"add","v":{"id":"msg-aaa","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"},"c":0}\n\n',
  // 帧 4：继承帧——只有 v（也是 snapshot）+ c
  'event: delta\ndata: {"v":{"id":"msg-aaa","content":{"parts":[""]},"status":"in_progress"},"c":1}\n\n',
  // 帧 5：仅 c
  'event: delta\ndata: {"c":5}\n\n',
  // 帧 6：user_visible_token marker
  'data: {"type":"message_marker","marker":"user_visible_token","event":"first"}\n\n',
  // 帧 7
  'event: delta\ndata: {"c":8}\n\n',
  // 帧 8
  'event: delta\ndata: {"c":9}\n\n',
  // 帧 9：final_channel_token（实测 marker 形如 "user_visible_token|final_channel_token"）
  'data: {"type":"message_marker","marker":"user_visible_token|final_channel_token","event":"first"}\n\n',
  // 帧 10：delta + 正文 append（v 含字面 \n——JSON 字符串里写成 \\n）
  'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"1\\n2\\n3\\n4\\n5\\n6\\n"}\n\n',
  // 帧 11：继承帧——只有 v（继承 frame 10 的 p/o）
  'event: delta\ndata: {"v":"7\\n8\\n9\\n10\\n"}\n\n',
  // 帧 12：继承帧——只有 v（"...\n...\n28" 是 doc 的字面占位符）
  'event: delta\ndata: {"v":"11\\n...\\n28"}\n\n',
  // 帧 13：patch 数组——4 个子项，append + replace + replace + append
  'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"\\n29\\n...\\n60"},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true},{"p":"/message/metadata","o":"append","v":{"is_complete":true,"finish_reason":"stop"}}]}\n\n',
  // 帧 14：last_token marker
  'data: {"type":"message_marker","marker":"last_token","event":"last"}\n\n',
  // 帧 15
  'data: {"type":"title_generation"}\n\n',
  // 帧 16
  'data: {"type":"title_generation"}\n\n',
  // 帧 17：metadata 路径上的 replace（p 不匹配正文路径，不产生内容事件）
  'event: delta\ndata: {"p":"/message/metadata/conversation_followup_suggestions_eligible","o":"replace","v":false}\n\n',
  // 帧 18
  'data: {"type":"server_ste_metadata"}\n\n',
  // 帧 19：message_stream_complete
  'data: {"type":"message_stream_complete"}\n\n',
  // 帧 20：[DONE]——data 根本不是 JSON
  'data: [DONE]\n\n',
];

/** 把一条 raw SSE 转成 SseFrame（用 Task 1 的 parseFrame）。 */
function frameFromRaw(raw: string): SseFrame {
  const f = parseFrame(raw);
  if (f === null) throw new Error(`parseFrame returned null for: ${JSON.stringify(raw)}`);
  return f;
}

// ===== 1. newStreamState 初值 =====
describe('newStreamState', () => {
  it('初值：lastP="", lastO="", phase="reasoning"', () => {
    expect(newStreamState()).toEqual({ lastP: '', lastO: '', phase: 'reasoning' });
  });

  it('每次返回新对象（不共享引用）', () => {
    const a = newStreamState();
    const b = newStreamState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ===== 2. 真实抓帧逐帧解释 =====
describe('interpretFrame × 真实抓帧（按协议 doc 帧序列）', () => {
  // ---- 帧 1 ----
  it('帧 1：delta_encoding → 返回 []（不更新 state）', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[0]!), state)).toEqual([]);
    expect(state).toEqual({ lastP: '', lastO: '', phase: 'reasoning' });
  });

  // ---- 帧 2：resume_conversation_token ----
  // brief 写「产出携带 conversationId 的事件」，但 ProviderStreamEvent 现有事件集无 conversationId 类型
  // （参考 src/background/providers/adapter.ts：只有 message_id / think_delta / content_delta /
  //   usage / stream_stats / stream_error）。为不破坏类型契约，interpretFrame 返回 []；
  // conversationId 由 bridge-client 层（Task 4）在 raw 帧层读取 SseFrame.data 再下传（不混入
  // 内容流）。本测试守住「不产事件 + 不改 state」。
  it('帧 2：resume_conversation_token → 返回 []，state 不变（conversationId 由 bridge-client 单独捕获）', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[1]!), state)).toEqual([]);
    expect(state).toEqual({ lastP: '', lastO: '', phase: 'reasoning' });
  });

  // ---- 帧 3 ----
  it('帧 3：add + 消息快照（v 是对象）→ 返回 []（不产生内容事件），但 state 更新 p/o', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[2]!), state)).toEqual([]);
    expect(state).toEqual({ lastP: '', lastO: 'add', phase: 'reasoning' });
  });

  // ---- 帧 4：继承帧（无 p/o、v 是对象） ----
  it('帧 4：仅 v 继承帧（v 是对象，非字符串）→ 返回 []', () => {
    const state = newStreamState();
    state.lastP = ''; state.lastO = 'add';
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[3]!), state)).toEqual([]);
    // 继承后 state 不变（帧 4 没 p/o）
    expect(state).toEqual({ lastP: '', lastO: 'add', phase: 'reasoning' });
  });

  // ---- 帧 5：仅 c ----
  it('帧 5：仅 c 计数器 → 返回 []，state 不变', () => {
    const state = newStreamState();
    state.lastP = ''; state.lastO = 'add';
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[4]!), state)).toEqual([]);
    expect(state).toEqual({ lastP: '', lastO: 'add', phase: 'reasoning' });
  });

  // ---- 帧 6：user_visible_token marker ----
  it('帧 6：user_visible_token marker → 返回 []，state.phase 不切', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[5]!), state)).toEqual([]);
    expect(state.phase).toBe('reasoning');
  });

  // ---- 帧 7/8：c 帧 ----
  it('帧 7/8：c 计数器 → 返回 []，state 不变', () => {
    for (const raw of [REAL_RAW_FRAMES[6]!, REAL_RAW_FRAMES[7]!]) {
      const state = newStreamState();
      state.lastP = ''; state.lastO = 'add';
      expect(interpretFrame(frameFromRaw(raw), state)).toEqual([]);
      expect(state).toEqual({ lastP: '', lastO: 'add', phase: 'reasoning' });
    }
  });

  // ---- 帧 9：final_channel_token 通道分界 ----
  it('帧 9：final_channel_token（| 分隔） → state.phase 切到 content，无返回内容事件', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[8]!), state)).toEqual([]);
    expect(state.phase).toBe('content');
  });

  // ---- 帧 10：正文 append ----
  it('帧 10：delta + 正文 append → content_delta（v 是字面含 \\n 的字符串）', () => {
    const state = newStreamState();
    state.phase = 'content';   // 模拟 frame 9 已切通道
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[9]!), state)).toEqual([
      { kind: 'content_delta', content: '1\n2\n3\n4\n5\n6\n' },
    ]);
    expect(state.lastP).toBe('/message/content/parts/0');
    expect(state.lastO).toBe('append');
  });

  // ---- 帧 11：继承帧（killer case，最容易写错） ----
  it('帧 11：仅 v 继承帧 → content_delta（沿用 frame 10 的 p/o）', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[10]!), state)).toEqual([
      { kind: 'content_delta', content: '7\n8\n9\n10\n' },
    ]);
    // 帧 11 不带 p/o，所以 state.lastP/lastO 不变
    expect(state.lastP).toBe('/message/content/parts/0');
    expect(state.lastO).toBe('append');
  });

  // ---- 帧 12：又一个继承帧 ----
  it('帧 12：仅 v 继承帧（v 含 "..." 占位符）→ content_delta', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[11]!), state)).toEqual([
      { kind: 'content_delta', content: '11\n...\n28' },
    ]);
  });

  // ---- 帧 13：patch 数组（killer case） ----
  it('帧 13：patch 数组 → 数组内的 append 产 content_delta，其余 3 项（status/end_turn/metadata）忽略', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    const events = interpretFrame(frameFromRaw(REAL_RAW_FRAMES[12]!), state);
    // 数组内第 1 项是 append → content_delta；其余 3 项均不匹配 /message/content/parts/0+append+string → []
    expect(events).toEqual([
      { kind: 'content_delta', content: '\n29\n...\n60' },
    ]);
    // patch 数组遍历后，最后一项更新 state：lastP=/message/metadata, lastO=append
    expect(state.lastP).toBe('/message/metadata');
    expect(state.lastO).toBe('append');
  });

  // ---- 帧 14：last_token marker ----
  it('帧 14：last_token marker → 返回 []，state 不变', () => {
    const state = newStreamState();
    state.phase = 'content';   // 模拟 frame 9 已切通道
    state.lastP = '/message/metadata';
    state.lastO = 'append';
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[13]!), state)).toEqual([]);
    expect(state.phase).toBe('content');   // 通道分界不回退
  });

  // ---- 帧 15/16：title_generation ----
  it('帧 15/16：title_generation → 返回 []', () => {
    for (const raw of [REAL_RAW_FRAMES[14]!, REAL_RAW_FRAMES[15]!]) {
      const state = newStreamState();
      expect(interpretFrame(frameFromRaw(raw), state)).toEqual([]);
    }
  });

  // ---- 帧 17：metadata 路径 replace（p 不匹配正文） ----
  it('帧 17：metadata 路径 replace（v 是 boolean）→ 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[16]!), state)).toEqual([
      // 不产 content_delta / think_delta，因为 p 不是 /message/content/parts/0
    ]);
    expect(state.lastP).toBe('/message/metadata/conversation_followup_suggestions_eligible');
    expect(state.lastO).toBe('replace');
  });

  // ---- 帧 18：server_ste_metadata ----
  it('帧 18：server_ste_metadata → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[17]!), state)).toEqual([]);
  });

  // ---- 帧 19：message_stream_complete ----
  it('帧 19：message_stream_complete → 返回 []（流自然结束，不产事件）', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[18]!), state)).toEqual([]);
  });

  // ---- 帧 20：[DONE] ----
  it('帧 20：[DONE]（非 JSON） → 返回 []，state 不变', () => {
    const state = newStreamState();
    expect(interpretFrame(frameFromRaw(REAL_RAW_FRAMES[19]!), state)).toEqual([]);
    expect(state).toEqual({ lastP: '', lastO: '', phase: 'reasoning' });
  });
});

// ===== 3. 通道分界（最容易写错） =====
describe('interpretFrame × 通道分界（final_channel_token）', () => {
  it('final_channel_token 之前：append → think_delta', () => {
    const state = newStreamState();
    // phase=reasoning（初值），直接 append 正文
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"思考中"}',
    }, state)).toEqual([
      { kind: 'think_delta', content: '思考中' },
    ]);
    expect(state.phase).toBe('reasoning');
  });

  it('final_channel_token 之后：append → content_delta', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"答复"}',
    }, state)).toEqual([
      { kind: 'content_delta', content: '答复' },
    ]);
  });

  it('marker 为纯 final_channel_token（无 | 前缀）也能切到 content', () => {
    const state = newStreamState();
    expect(interpretFrame({
      event: null,
      data: '{"type":"message_marker","marker":"final_channel_token","event":"first"}',
    }, state)).toEqual([]);
    expect(state.phase).toBe('content');
  });

  it('无 final_channel_token marker → phase 保持 reasoning，所有 append 都是 think_delta', () => {
    const state = newStreamState();
    for (const chunk of ['x', 'y', 'z']) {
      expect(interpretFrame({
        event: 'delta',
        data: `{"p":"/message/content/parts/0","o":"append","v":"${chunk}"}`,
      }, state)).toEqual([
        { kind: 'think_delta', content: chunk },
      ]);
    }
    expect(state.phase).toBe('reasoning');
  });

  it('reasoning 段多个 append 帧顺序累加，全部 think_delta；切通道后再 append 是 content_delta', () => {
    const state = newStreamState();
    // 推理段
    expect(interpretFrame({ event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"先"}' }, state))
      .toEqual([{ kind: 'think_delta', content: '先' }]);
    expect(interpretFrame({ event: 'delta', data: '{"v":"想"}' }, state))   // 继承
      .toEqual([{ kind: 'think_delta', content: '想' }]);
    // 切通道
    expect(interpretFrame({ event: null, data: '{"type":"message_marker","marker":"user_visible_token|final_channel_token"}' }, state))
      .toEqual([]);
    expect(state.phase).toBe('content');
    // 答复段
    expect(interpretFrame({ event: 'delta', data: '{"v":"答案"}' }, state))
      .toEqual([{ kind: 'content_delta', content: '答案' }]);
  });
});

// ===== 4. p/o 跨帧继承（最容易写错） =====
describe('interpretFrame × p/o 跨帧继承', () => {
  it('无 p/o 的 v 帧沿用 state.lastP/lastO', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame({ event: 'delta', data: '{"v":"正文片段"}' }, state))
      .toEqual([{ kind: 'content_delta', content: '正文片段' }]);
    expect(state.lastP).toBe('/message/content/parts/0');   // 没改
    expect(state.lastO).toBe('append');
  });

  it('多帧连续无 p/o，全部继承第一帧的 p/o', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    const chunks = ['A', 'B', 'C'];
    for (const c of chunks) {
      expect(interpretFrame({ event: 'delta', data: `{"v":"${c}"}` }, state))
        .toEqual([{ kind: 'content_delta', content: c }]);
    }
    expect(state.lastP).toBe('/message/content/parts/0');
    expect(state.lastO).toBe('append');
  });

  it('完整帧后跟无 p/o 帧，p/o 不被覆盖', () => {
    const state = newStreamState();
    state.phase = 'content';
    // 完整帧 p=metadata 路径，op=replace
    interpretFrame({ event: 'delta', data: '{"p":"/message/metadata/x","o":"replace","v":1}' }, state);
    expect(state.lastP).toBe('/message/metadata/x');
    expect(state.lastO).toBe('replace');
    // 下一个无 p/o 帧 → 沿用 metadata 路径，但 v 不是 string，不产 content_delta（p 不匹配正文）
    expect(interpretFrame({ event: 'delta', data: '{"v":"x"}' }, state)).toEqual([]);
    expect(state.lastP).toBe('/message/metadata/x');
  });

  it('继承链上的 v 字符串续帧——输出总长篇关键', () => {
    // 这正是 doc 的核心教训：不继承会让续帧被当成 p="" o 缺省的 op，全部丢失
    const state = newStreamState();
    state.phase = 'content';
    // 完整帧
    expect(interpretFrame({ event: 'delta', data: '{"p":"/message/content/parts/0","o":"append","v":"第一段"}' }, state))
      .toEqual([{ kind: 'content_delta', content: '第一段' }]);
    // 续帧（只有 v）
    expect(interpretFrame({ event: 'delta', data: '{"v":"续段"}' }, state))
      .toEqual([{ kind: 'content_delta', content: '续段' }]);
  });
});

// ===== 5. patch 数组展开 =====
describe('interpretFrame × patch 数组展开', () => {
  it('patch 数组内的 append 与顶层 append 同等处理', () => {
    const state = newStreamState();
    state.phase = 'content';
    const events = interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"patch-content"}]}',
    }, state);
    expect(events).toEqual([{ kind: 'content_delta', content: 'patch-content' }]);
  });

  it('patch 数组内的非 append op（status、metadata 等）→ 忽略', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
    }, state)).toEqual([]);
  });

  it('patch 数组内每一项都更新 state.lastP/lastO（最后一项目录生效）', () => {
    const state = newStreamState();
    state.phase = 'content';
    interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"a"},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/metadata","o":"append","v":{}}]}',
    }, state);
    expect(state.lastP).toBe('/message/metadata');
    expect(state.lastO).toBe('append');
  });

  it('patch 数组混合内容 op 与状态 op → 只产出内容事件', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"hello"},{"p":"/message/content/parts/0","o":"append","v":" world"},{"p":"/message/status","o":"replace","v":"finished_successfully"}]}',
    }, state)).toEqual([
      { kind: 'content_delta', content: 'hello' },
      { kind: 'content_delta', content: ' world' },
    ]);
  });

  it('非 patch 顶层（p 不是 ""）→ 不展开数组（即便 v 是数组也按单条 op 处理）', () => {
    const state = newStreamState();
    state.phase = 'content';
    // p="/message/content/parts/0"、o="append"、v=数组 → processOp 看到 v 不是 string → []
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":["不","是","字","符","串"]}',
    }, state)).toEqual([]);
  });

  it('patch 数组但 state.phase=reasoning → 数组内的 append 产 think_delta', () => {
    const state = newStreamState();
    state.phase = 'reasoning';
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"推理片段"}]}',
    }, state)).toEqual([{ kind: 'think_delta', content: '推理片段' }]);
  });
});

// ===== 6. error 字段 =====
describe('interpretFrame × error 字段', () => {
  it('顶层 error 字段为非空字符串 → stream_error', () => {
    const state = newStreamState();
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"","o":"add","v":{"id":"x","author":{"role":"assistant"},"content":{"parts":[""]},"error":"rate_limited","error_code":"too_many_requests"}}',
    }, state)).toEqual([
      { kind: 'stream_error', message: 'rate_limited', reason: 'too_many_requests' },
    ]);
  });

  it('顶层 type="error" 帧 → stream_error（与 DeepSeek 的 {type:"error",content} 同形）', () => {
    const state = newStreamState();
    expect(interpretFrame({
      event: null,
      data: '{"type":"error","content":"Server is temporarily unavailable.","finish_reason":"generation_err"}',
    }, state)).toEqual([
      { kind: 'stream_error', message: 'Server is temporarily unavailable.', reason: 'generation_err' },
    ]);
  });

  it('顶层 error_code 单独非空（error 为空字符串）→ stream_error', () => {
    const state = newStreamState();
    expect(interpretFrame({
      event: null,
      data: '{"type":"some","error":"","error_code":"forbidden"}',
    }, state)).toEqual([
      { kind: 'stream_error', message: 'error_code: forbidden', reason: 'forbidden' },
    ]);
  });

  it('error 字段为空字符串 → 不当成错误（正常走内容路径）', () => {
    const state = newStreamState();
    state.phase = 'content';   // 模拟 final_channel_token 已切通道
    // error 是空串，照常走 delta 路径；v 是空字符串 → content_delta with content ''
    expect(interpretFrame({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"","error":""}',
    }, state)).toEqual([{ kind: 'content_delta', content: '' }]);
  });
});

// ===== 7. 边界 =====
describe('interpretFrame × 边界', () => {
  it('JSON 解析失败（data 不是 JSON） → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame({ event: null, data: '[DONE]' }, state)).toEqual([]);
  });

  it('data 是 JSON 字符串（"v1"） → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame({ event: 'delta_encoding', data: '"v1"' }, state)).toEqual([]);
  });

  it('data 是 JSON null → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame({ event: null, data: 'null' }, state)).toEqual([]);
  });

  it('data 是 JSON 数组 → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame({ event: null, data: '[1,2,3]' }, state)).toEqual([]);
  });

  it('空对象 {} → 返回 []', () => {
    const state = newStreamState();
    expect(interpretFrame({ event: 'delta', data: '{}' }, state)).toEqual([]);
  });

  it('v 是 null（继承 p/o 后 v 不是 string） → 返回 []', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame({ event: 'delta', data: '{"v":null}' }, state)).toEqual([]);
  });

  it('delta 但 p 不匹配正文路径，v 是字符串 → 返回 []（避免误把 metadata 之类当正文）', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame({ event: 'delta', data: '{"p":"/message/other","o":"append","v":"text"}' }, state)).toEqual([]);
  });

  it('delta 但 o 不是 append（replace） → 返回 []', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame({ event: 'delta', data: '{"p":"/message/content/parts/0","o":"replace","v":"text"}' }, state)).toEqual([]);
  });
});

// ===== 8. 全帧序列端到端（用 splitFrames 串起来跑） =====
describe('interpretFrame × 协议 doc 帧序列端到端', () => {
  it('按 20 帧顺序喂入 → 仅 4 个 content_delta（帧 10/11/12/13 的内容片段）', () => {
    // 用 Task 1 的 splitFrames + parseFrame 把 raw SSE 切成 SseFrame 数组
    const buf = REAL_RAW_FRAMES.join('');
    const { frames, rest } = splitFrames(buf);
    expect(rest).toBe('');
    expect(frames).toHaveLength(REAL_RAW_FRAMES.length);

    const state = newStreamState();
    const allEvents = [];
    for (const raw of frames) {
      const f = parseFrame(raw);
      if (f === null) continue;
      const events = interpretFrame(f, state);
      for (const e of events) allEvents.push(e);
    }

    // doc 序列里只有帧 10/11/12/13 产 content_delta
    expect(allEvents).toEqual([
      { kind: 'content_delta', content: '1\n2\n3\n4\n5\n6\n' },
      { kind: 'content_delta', content: '7\n8\n9\n10\n' },
      { kind: 'content_delta', content: '11\n...\n28' },
      { kind: 'content_delta', content: '\n29\n...\n60' },
    ]);

    // 流末 state 应在 content 阶段、lastP/lastO 跟 frame 17 的 metadata replace 一致
    expect(state.phase).toBe('content');
    expect(state.lastP).toBe('/message/metadata/conversation_followup_suggestions_eligible');
    expect(state.lastO).toBe('replace');
  });

  it('同序列喂两次：第二次与第一次结果完全一致（state 不残留可测性）', () => {
    const buf = REAL_RAW_FRAMES.join('');
    const { frames } = splitFrames(buf);

    const runOnce = () => {
      const state = newStreamState();
      const events = [];
      for (const raw of frames) {
        const f = parseFrame(raw);
        if (f === null) continue;
        events.push(...interpretFrame(f, state));
      }
      return { events, finalState: { ...state } };
    };

    const r1 = runOnce();
    const r2 = runOnce();
    expect(r1.events).toEqual(r2.events);
    expect(r1.finalState).toEqual(r2.finalState);
  });
});
// ===== 9. 帧级 ops 批次（fix/chatgpt-ops-batch-and-cite） =====
// 现场 bug：一次回答被切成 8 个数组批次，其中 6 个帧级没有 p/o（形如 {"v":[{...ops...}]}）。
// 旧代码用 p === '' 认批次，而这 6 帧的 p 会继承成 /message/content/parts/0 → 判定不成立 →
// 整批 ops（含正文）落到 processSingleOp（v 是数组、不是字符串）→ 全部丢弃。
// 本节守住「帧级无 p/o 的批次也必须展开」。

/** 构造 delta 帧：body 用 JSON.stringify 序列化，省得手写私有区字符 / 换行的转义。 */
function deltaFrame(body: Record<string, unknown>): SseFrame {
  return { event: 'delta', data: JSON.stringify(body) };
}

describe('interpretFrame × 帧级 ops 批次（无 p/o 的帧也必须展开）', () => {
  it('帧级只有 v 的 ops 批次 → 展开产出内容（不得依赖 p === ""）', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame(deltaFrame({
      v: [{ p: '/message/content/parts/0', o: 'append', v: 'A' }],
    }), state)).toEqual([{ kind: 'content_delta', content: 'A' }]);
    // 展开后 state 落到批次最后一项的 p/o
    expect(state.lastP).toBe('/message/content/parts/0');
    expect(state.lastO).toBe('append');
  });

  it('批次内内容 op 与非内容 op 混排（含字符串数组 v 的 metadata op）→ 只产内容事件', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    expect(interpretFrame(deltaFrame({
      v: [
        { p: '/message/content/parts/0', o: 'append', v: 'B' },
        { p: '/message/metadata/safe_urls', o: 'append', v: ['https://a.example'] },
        { p: '/message/content/parts/0', o: 'append', v: 'C' },
      ],
    }), state)).toEqual([
      { kind: 'content_delta', content: 'B' },
      { kind: 'content_delta', content: 'C' },
    ]);
  });

  it('反例 (a)：v 是字符串数组的 metadata op → 不产内容、不抛异常', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    let events: ProviderStreamEvent[] = [];
    expect(() => {
      events = interpretFrame(deltaFrame({
        p: '/message/metadata/content_references/0/safe_urls',
        o: 'append',
        v: ['https://a.example', 'https://b.example'],
      }), state);
    }).not.toThrow();
    expect(events).toEqual([]);
  });

  it('反例 (b)：v 是「无 p 的对象数组」的 metadata op → 不产内容、不抛异常', () => {
    const state = newStreamState();
    state.phase = 'content';
    state.lastP = '/message/content/parts/0';
    state.lastO = 'append';
    let events: ProviderStreamEvent[] = [];
    expect(() => {
      events = interpretFrame(deltaFrame({
        p: '/message/metadata/content_references',
        o: 'append',
        v: [{ matched_text: '11', end_idx: 42 }],
      }), state);
    }).not.toThrow();
    expect(events).toEqual([]);
  });
});

// ===== 10. 引用标记清洗（fix/chatgpt-ops-batch-and-cite） =====
// 实测码点：U+E200 起始、U+E202 分隔、U+E201 结束；本次抓帧 6 个标记全是 \uE200cite\uE202turn0newsN\uE201。
// 用户拍板：直接从正文删掉（不换链接、不保留来源名）。
// 正文是流式分片到达的 → 标记可能跨 delta 断裂 → 清洗必须有跨帧扣留逻辑（不能只做全局替换）。
const CITE_START = '\uE200';
const CITE_END = '\uE201';
const CONTENT_PATH = '/message/content/parts/0';

/** 拼一个实测形态的引用标记。 */
function cite(n: number): string {
  return `${CITE_START}cite\uE202turn0news${n}${CITE_END}`;
}

describe('interpretFrame × 引用标记清洗', () => {
  it('完整标记被删除，相邻正文保留', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame(deltaFrame({ p: CONTENT_PATH, o: 'append', v: `a${cite(1)}b` }), state))
      .toEqual([{ kind: 'content_delta', content: 'ab' }]);
  });

  it('连续多个标记 → 只留正文', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame(deltaFrame({ p: CONTENT_PATH, o: 'append', v: `a${cite(1)}b${cite(2)}c` }), state))
      .toEqual([{ kind: 'content_delta', content: 'abc' }]);
  });

  it('标记跨 delta 断裂：半截被扣留，下一帧补齐后不泄漏、不重复、不丢相邻正文', () => {
    const state = newStreamState();
    state.phase = 'content';
    // 第一片以半截标记结尾（"前\uE200cit"）——半截不得原样发给用户
    expect(interpretFrame(deltaFrame({ p: CONTENT_PATH, o: 'append', v: `前${CITE_START}cit` }), state))
      .toEqual([{ kind: 'content_delta', content: '前' }]);
    // 第二片以半截开头（"e\uE202turn0news2\uE201后"）——与扣留的 "\uE200cit" 拼成完整标记后整体删除
    expect(interpretFrame(deltaFrame({ v: `e\uE202turn0news2${CITE_END}后` }), state))
      .toEqual([{ kind: 'content_delta', content: '后' }]);
  });

  it('流结束时仍未闭合的半截标记 → 丢弃，只剩正文', () => {
    const state = newStreamState();
    state.phase = 'content';
    expect(interpretFrame(deltaFrame({ p: CONTENT_PATH, o: 'append', v: `正文${CITE_START}cite\uE202turn0` }), state))
      .toEqual([{ kind: 'content_delta', content: '正文' }]);
  });

  it('think_delta 通道同样清洗', () => {
    const state = newStreamState();   // phase 初值 reasoning
    expect(interpretFrame(deltaFrame({ p: CONTENT_PATH, o: 'append', v: `想${cite(3)}` }), state))
      .toEqual([{ kind: 'think_delta', content: '想' }]);
  });
});

// ===== 11. 真实抓帧回归（2026-10-02 联网回答，36 帧） =====
// 夹具来源：真实 ChatGPT 联网回答抓帧，含 8 个 ops 批次帧（其中 6 个帧级无 p/o）。
// EXPECTED_NEWS_TEXT = 页面 DOM 真值（536 字符）。
// Bug 现场：旧代码只产出 194 字（6 个批次整批丢弃），从中段开始错位、结尾断在半句。
interface CapturedFrame {
  /** SSE event 字段（抓帧时未给出的帧为 null）。 */
  e: string | null;
  /** SSE data 字段原文。 */
  d: string;
}

function loadCapturedFrames(): SseFrame[] {
  const path = join(__dirname, '..', 'fixtures', 'chatgpt-frames-news.json');
  const captured = JSON.parse(readFileSync(path, 'utf8')) as CapturedFrame[];
  return captured.map((f) => ({ event: f.e, data: f.d }));
}

const EXPECTED_NEWS_TEXT = "我查了一下今天（2026年10月2日）北京的新闻，比较受关注的本地新闻主要有这些：\n\n### 🏙️ 城市与民生\n\n**1. 昌平举办国庆主题嘉年华活动**  \n昌平区东小口镇“盛世迎华诞，奥北耀星河2026奥北金秋国庆嘉年华”启动，活动贯穿国庆假期，包括文化、休闲等系列活动。\n\n**2. 颐堤港将更名为“北京太古坊”**  \n北京商业地标颐堤港宣布，自2026年11月1日起将正式更名为“北京太古坊”。报道显示，此次调整不仅是名称变化，也涉及项目升级规划。\n\n### 🎭 文化活动\n\n**3. 国庆期间北京文化活动增多**  \n国庆假期，北京多地安排文化活动，包括书店分享会、艺术展览等。例如东城区有文学分享活动，邀请作家、学者参与。\n\n**4. 北京大学生艺术节艺术作品展举行**  \n2026年北京大学生艺术节艺术作品及艺术实践工作坊展览在中国人民大学美术馆启幕，展示高校艺术实践成果。\n\n### 📸 节日旅游\n\n**5. 国庆北京旅游热度持续**  \n新华社报道记录了国庆期间天安门广场、故宫、北海公园、火车站等地游客活动，通过新旧照片对比展示北京城市变化。\n\n---\n\n如果你关心的是**北京科技/AI行业新闻、创业融资、互联网公司动态**，我也可以单独搜一版。";

describe('interpretFrame × 真实抓帧回归（2026-10-02 联网回答）', () => {
  it('36 帧全部喂入 → content_delta 拼接逐字等于页面真值（536 字符）', () => {
    const frames = loadCapturedFrames();
    expect(frames).toHaveLength(36);
    const state = newStreamState();
    const parts: string[] = [];
    for (const frame of frames) {
      for (const ev of interpretFrame(frame, state)) {
        if (ev.kind === 'content_delta') parts.push(ev.content);
      }
    }
    const text = parts.join('');
    // 按码点计数：页面真值 536 个字符（String#length 是 UTF-16 单元，文中 3 个 emoji 会多算 3）
    expect([...text].length).toBe(536);
    expect(text).toBe(EXPECTED_NEWS_TEXT);
  });

  it('同 36 帧喂两次 → 输出与终态一致（跨帧状态不残留）', () => {
    const frames = loadCapturedFrames();
    const run = () => {
      const state = newStreamState();
      const parts: string[] = [];
      for (const frame of frames) {
        for (const ev of interpretFrame(frame, state)) {
          if (ev.kind === 'content_delta') parts.push(ev.content);
        }
      }
      return { text: parts.join(''), state: { ...state } };
    };
    expect(run()).toEqual(run());
  });
});
