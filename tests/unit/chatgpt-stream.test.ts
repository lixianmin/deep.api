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
import { interpretFrame, newStreamState } from '../../src/background/providers/chatgpt/stream';
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