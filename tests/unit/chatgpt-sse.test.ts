import { describe, it, expect } from 'vitest';
import { splitFrames, parseFrame } from '../../src/shared/chatgpt-sse';

// ===== 真实帧（2026-10-01 实测抓帧，协议 doc §「SSE 帧协议」）=====
// 直接照搬 docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md 的帧序列当夹具。
// 拆帧是纯函数：data 保留原始字符串，**不**做 JSON.parse——下游 Task 2 处理事件分发。
const realFrames: string[] = [
  // 帧 1：event + data（JSON 字符串包裹的版本号）
  'event: delta_encoding\ndata: "v1"\n\n',
  // 帧 2：无 event，纯 data，JSON 对象
  'data: {"type":"resume_conversation_token","conversation_id":"uuid-abc","token":"eyJhbGc.x"}\n\n',
  // 帧 3：event + data，p/o/v 形态（实测）
  'event: delta\ndata: {"p":"","o":"add","v":{"id":"msg-1","author":{"role":"assistant"}},"c":0}\n\n',
  // 帧 4：继承帧——只有 c（counter）
  'event: delta\ndata: {"c":1}\n\n',
  // 帧 6：message_marker
  'data: {"type":"message_marker","marker":"user_visible_token","event":"first"}\n\n',
  // 帧 9：final_channel_token 切通道
  'data: {"type":"message_marker","marker":"user_visible_token|final_channel_token","event":"first"}\n\n',
  // 帧 10：正文 append（v 是多行文本）
  'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"1\\n2\\n3"}\n\n',
  // 帧 19：message_stream_complete
  'data: {"type":"message_stream_complete"}\n\n',
  // 帧 20：流结束哨兵 [DONE]——data 根本不是 JSON
  'data: [DONE]\n\n',
];

describe('parseFrame', () => {
  // ---- brief §1：data 行要剥掉一个前导空格 ----
  it('剥掉 data 行冒号后的单前导空格（data: foo → foo）', () => {
    expect(parseFrame('data: {"x":1}\n\n')).toEqual({ event: null, data: '{"x":1}' });
  });

  // ---- brief §3：data: [DONE] 保留原始字符串（不是 JSON） ----
  it('data: [DONE] 保留原始字符串（不解析、不报错）', () => {
    expect(parseFrame('data: [DONE]\n\n')).toEqual({ event: null, data: '[DONE]' });
  });

  // ---- brief §3：data: "v1" 保留原始字符串 ----
  it('data: "v1"（JSON 字符串）保留原始字符串', () => {
    expect(parseFrame('data: "v1"\n\n')).toEqual({ event: null, data: '"v1"' });
  });

  // ---- 帧 1：event + data ----
  it('event + data：event: delta_encoding\ndata: "v1"', () => {
    expect(parseFrame('event: delta_encoding\ndata: "v1"\n\n'))
      .toEqual({ event: 'delta_encoding', data: '"v1"' });
  });

  // ---- 帧 2：data only → event 为 null ----
  it('只有 data 行 → event 为 null', () => {
    expect(parseFrame('data: {"type":"resume_conversation_token","token":"x"}\n\n'))
      .toEqual({ event: null, data: '{"type":"resume_conversation_token","token":"x"}' });
  });

  // ---- 帧 10：data 含换行符（JSON 字符串里的 \\n） ----
  it('data 含 JSON 转义的换行符原样保留', () => {
    const f = 'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"1\\n2\\n3"}\n\n';
    expect(parseFrame(f)).toEqual({
      event: 'delta',
      data: '{"p":"/message/content/parts/0","o":"append","v":"1\\n2\\n3"}',
    });
  });

  // ---- brief §4：空帧返回 null ----
  it('空字符串 → null', () => {
    expect(parseFrame('')).toBeNull();
  });

  it('只有空行（"\\n\\n"） → null', () => {
    expect(parseFrame('\n\n')).toBeNull();
  });

  // ---- brief §4：无 data 帧返回 null ----
  it('只有 event: 行无 data: → null', () => {
    expect(parseFrame('event: ping\n\n')).toBeNull();
  });

  it('注释行 + event 行无 data → null', () => {
    // : heartbeat 是 SSE 注释（首字符 :），应忽略
    expect(parseFrame(': heartbeat\nevent: ping\n\n')).toBeNull();
  });

  // ---- 空 data 值 → null（与既有 DeepSeek 解析器行为一致：filter e.data !== ''） ----
  it('data: 后空值 → null', () => {
    expect(parseFrame('data:\n\n')).toBeNull();
    expect(parseFrame('data: \n\n')).toBeNull();  // 仅一个空格也是空
  });

  // ---- 多 data 行：SSE 规范要求用 \\n 拼接 ----
  it('多 data 行用 \\n 拼接（标准 SSE 行为）', () => {
    expect(parseFrame('data: line1\ndata: line2\n\n'))
      .toEqual({ event: null, data: 'line1\nline2' });
  });

  // ---- data 行无前导空格 ----
  it('data:foo（无空格）→ 原样保留（不强行剥）', () => {
    expect(parseFrame('data:foo\n\n')).toEqual({ event: null, data: 'foo' });
  });

  // ---- 多余空格只剥一个 ----
  it('data:  foo（两个空格）→ 只剥一个，剩一个', () => {
    expect(parseFrame('data:  foo\n\n')).toEqual({ event: null, data: ' foo' });
  });

  // ---- event 行同样剥一个前导空格 ----
  it('event: 后多余空格只剥一个', () => {
    expect(parseFrame('event:  delta\ndata: x\n\n'))
      .toEqual({ event: ' delta', data: 'x' });
  });

  // ---- 未知字段忽略 ----
  it('未知字段行（id: 1）忽略', () => {
    expect(parseFrame('id: 42\ndata: x\n\n')).toEqual({ event: null, data: 'x' });
  });

  // ---- 注释行（: 开头）忽略 ----
  it(': 开头的注释行忽略', () => {
    expect(parseFrame(': keepalive\ndata: real\n\n')).toEqual({ event: null, data: 'real' });
  });

  // ---- 多行 event 全部累积到一个 event 字段？协议层要求 event 多行就后者覆盖前者 ----
  // 实测 ChatGPT 不会出现多 event 行；这里取 SSE 默认行为（后者覆盖）
  it('多个 event 行：后者覆盖前者', () => {
    expect(parseFrame('event: a\nevent: b\ndata: x\n\n'))
      .toEqual({ event: 'b', data: 'x' });
  });

  // ---- 真实抓帧全集（直接拿协议 spec 的帧） ----
  it.each(realFrames.map((raw, i) => [raw, i] as const))(
    '真实帧 #%i → 拆出 event/data',
    (_raw, _idx) => { /* 在下个 it.each 关联断言 */ },
  );
});

describe('parseFrame × 真实抓帧（协议 doc 实测）', () => {
  // 帧 1
  it('帧 1：delta_encoding + "v1"', () => {
    expect(parseFrame(realFrames[0]!))
      .toEqual({ event: 'delta_encoding', data: '"v1"' });
  });
  // 帧 2
  it('帧 2：resume_conversation_token（无 event）', () => {
    expect(parseFrame(realFrames[1]!)).toEqual({
      event: null,
      data: '{"type":"resume_conversation_token","conversation_id":"uuid-abc","token":"eyJhbGc.x"}',
    });
  });
  // 帧 3
  it('帧 3：delta + add + 消息快照', () => {
    const f = parseFrame(realFrames[2]!);
    expect(f?.event).toBe('delta');
    expect(f?.data).toContain('"o":"add"');
    expect(f?.data).toContain('"role":"assistant"');
  });
  // 帧 4：继承帧只有 c
  it('帧 4：delta + 简写增量 {"c":1}', () => {
    const f = parseFrame(realFrames[3]!);
    expect(f?.event).toBe('delta');
    expect(f?.data).toBe('{"c":1}');
  });
  // 帧 6：message_marker
  it('帧 6：user_visible_token marker', () => {
    expect(parseFrame(realFrames[4]!)).toEqual({
      event: null,
      data: '{"type":"message_marker","marker":"user_visible_token","event":"first"}',
    });
  });
  // 帧 9：final_channel_token 通道分界
  it('帧 9：final_channel_token marker（含 | 分隔）', () => {
    const f = parseFrame(realFrames[5]!);
    expect(f?.event).toBeNull();
    expect(f?.data).toContain('final_channel_token');
  });
  // 帧 10：正文 append
  it('帧 10：delta + 正文 append（v 含 \\n）', () => {
    const f = parseFrame(realFrames[6]!);
    expect(f?.event).toBe('delta');
    expect(f?.data).toContain('"append"');
  });
  // 帧 19
  it('帧 19：message_stream_complete', () => {
    expect(parseFrame(realFrames[7]!)).toEqual({
      event: null,
      data: '{"type":"message_stream_complete"}',
    });
  });
  // 帧 20：[DONE]
  it('帧 20：[DONE]（不是 JSON）', () => {
    expect(parseFrame(realFrames[8]!)).toEqual({ event: null, data: '[DONE]' });
  });
});

describe('splitFrames', () => {
  // ---- 空 buffer ----
  it('空 buffer → frames=[], rest=""', () => {
    expect(splitFrames('')).toEqual({ frames: [], rest: '' });
  });

  // ---- brief §2：未成帧的尾巴留在 rest ----
  it('无 \\n\\n（数据未成帧）→ frames=[], rest=全部', () => {
    expect(splitFrames('event: ping\ndata: {"x":1}')).toEqual({
      frames: [],
      rest: 'event: ping\ndata: {"x":1}',
    });
  });

  it('单 \\n（半截帧边界）→ 全部进 rest', () => {
    expect(splitFrames('event: ping\n')).toEqual({
      frames: [],
      rest: 'event: ping\n',
    });
  });

  // ---- 完整帧：拆出，rest 为空 ----
  it('单完整帧（\\n\\n 结尾）→ 拆出 1 帧，rest=""', () => {
    expect(splitFrames('event: ping\ndata: {"x":1}\n\n')).toEqual({
      frames: ['event: ping\ndata: {"x":1}'],
      rest: '',
    });
  });

  // ---- 多完整帧 ----
  it('两完整帧 → 拆出 2 帧', () => {
    const buf = 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n';
    expect(splitFrames(buf)).toEqual({
      frames: ['event: a\ndata: 1', 'event: b\ndata: 2'],
      rest: '',
    });
  });

  // ---- brief §2（本任务最容易写错）：帧被切断，留 rest ----
  it('一帧完整 + 一帧半截 → 完整帧拆出，半截进 rest', () => {
    expect(splitFrames('event: a\ndata: 1\n\nevent: b\ndata: 2')).toEqual({
      frames: ['event: a\ndata: 1'],
      rest: 'event: b\ndata: 2',
    });
  });

  // ---- 跨 chunk：data 行中间被切断（killer case） ----
  it('跨 chunk：data 行在中间被切断 → 半截进 rest，下次拼接完成', () => {
    // 第 1 次：data 截到一半
    const r1 = splitFrames('event: delta\ndata: {"x":');
    expect(r1).toEqual({ frames: [], rest: 'event: delta\ndata: {"x":' });
    // 第 2 次：把后续 chunk 拼上去 = 完整帧
    const r2 = splitFrames(r1.rest + '1,"y":2}\n\n');
    expect(r2).toEqual({
      frames: ['event: delta\ndata: {"x":1,"y":2}'],
      rest: '',
    });
    // 解析结果应是预期
    expect(parseFrame(r2.frames[0]!)).toEqual({
      event: 'delta',
      data: '{"x":1,"y":2}',
    });
  });

  // ---- 跨 chunk：在 \\n\\n 边界上切断（chunk 1 以 \\n 结尾） ----
  it('跨 chunk：\\n\\n 边界正好切在 chunk 衔接处', () => {
    const r1 = splitFrames('event: a\ndata: 1\n');
    expect(r1).toEqual({ frames: [], rest: 'event: a\ndata: 1\n' });
    const r2 = splitFrames(r1.rest + '\nevent: b\ndata: 2\n\n');
    expect(r2).toEqual({
      frames: ['event: a\ndata: 1', 'event: b\ndata: 2'],
      rest: '',
    });
  });

  // ---- brief §4：\\r\\n 容错 ----
  it('\\r\\n 行尾 + \\r\\n\\r\\n 分隔 → 与 \\n 等价', () => {
    const buf = 'event: ping\r\ndata: {"x":1}\r\n\r\n';
    const r = splitFrames(buf);
    expect(r.frames).toHaveLength(1);
    expect(parseFrame(r.frames[0]!)).toEqual({ event: 'ping', data: '{"x":1}' });
  });

  it('混合 \\n 与 \\r\\n 行尾 → 仍能正确拆帧', () => {
    const buf = 'event: a\ndata: 1\n\nevent: b\r\ndata: 2\r\n\r\n';
    const r = splitFrames(buf);
    expect(r.frames).toHaveLength(2);
    expect(r.rest).toBe('');
    expect(parseFrame(r.frames[0]!)).toEqual({ event: 'a', data: '1' });
    expect(parseFrame(r.frames[1]!)).toEqual({ event: 'b', data: '2' });
  });

  // ---- trailing \\n\\n（连续空帧） → 过滤空帧 ----
  it('trailing \\n\\n\\n\\n（多空帧）→ 不产出空帧', () => {
    const r = splitFrames('event: a\ndata: 1\n\n\n\n');
    expect(r).toEqual({ frames: ['event: a\ndata: 1'], rest: '' });
  });

  // ---- buffer 全是空帧 → frames=[] ----
  it('buffer 全是空行（"\\n\\n\\n\\n"）→ frames=[]', () => {
    expect(splitFrames('\n\n\n\n')).toEqual({ frames: [], rest: '' });
  });

  // ---- 真实协议帧拼接 ----
  it('真实帧拼接 → 全部正确拆出 + 解析', () => {
    const buf = realFrames.join('');
    const r = splitFrames(buf);
    expect(r.frames).toHaveLength(realFrames.length);
    expect(r.rest).toBe('');
    // 每一帧都能 parse 出预期形态
    const parsed = r.frames.map(parseFrame);
    expect(parsed[0]).toEqual({ event: 'delta_encoding', data: '"v1"' });
    expect(parsed[1]).toEqual({
      event: null,
      data: '{"type":"resume_conversation_token","conversation_id":"uuid-abc","token":"eyJhbGc.x"}',
    });
    expect(parsed[parsed.length - 1]).toEqual({ event: null, data: '[DONE]' });
  });

  // ---- 真实帧被切成 3 段网络 chunk（最现实场景） ----
  it('真实帧切成 3 段：每段 splitFrames → 拼起来 = 全部帧', () => {
    const buf = realFrames.join('');
    // 切点：故意跨帧、跨行
    const cut1 = 30;   // 帧 1 中段
    const cut2 = buf.indexOf('\n\n', cut1) + 4;  // 帧 2/3 之间
    const chunk1 = buf.slice(0, cut1);
    const chunk2 = buf.slice(cut1, cut2);
    const chunk3 = buf.slice(cut2);

    const r1 = splitFrames(chunk1);
    const r2 = splitFrames(r1.rest + chunk2);
    const r3 = splitFrames(r2.rest + chunk3);

    const allFrames = [...r1.frames, ...r2.frames, ...r3.frames];
    expect(allFrames).toHaveLength(realFrames.length);
    expect(r3.rest).toBe('');
    // 最后一帧仍是 [DONE]
    expect(parseFrame(allFrames[allFrames.length - 1]!)).toEqual({ event: null, data: '[DONE]' });
  });

  // ---- 末尾无 \\n\\n 的尾帧（stream 关闭时常见） ----
  it('buffer 末尾恰好是 \\n（缺一个换行），整段进 rest 等下次', () => {
    const buf = 'event: tail\ndata: last';
    expect(splitFrames(buf)).toEqual({ frames: [], rest: buf });
  });
});

describe('splitFrames × parseFrame 协作（端到端）', () => {
  it('真实流边读边拆边解析，所有 [DONE] 帧都正确识别', () => {
    const buf = realFrames.join('');
    const r = splitFrames(buf);
    const doneFrames = r.frames.map(parseFrame).filter(f => f?.data === '[DONE]');
    expect(doneFrames).toHaveLength(1);
    expect(doneFrames[0]).toEqual({ event: null, data: '[DONE]' });
  });

  it('跨 chunk 拆出的帧，解析后 data 字段无任何多余空格', () => {
    // 故意把 data 值前面切一刀，确保拼接后空格只剥一次
    const chunk1 = 'data: {"a":';
    const chunk2 = '1}\n\n';
    const r1 = splitFrames(chunk1);
    const r2 = splitFrames(r1.rest + chunk2);
    const parsed = parseFrame(r2.frames[0]!);
    expect(parsed).toEqual({ event: null, data: '{"a":1}' });
    // 防止有人写出「永远剥所有空格」的 bug
    expect(parsed?.data.startsWith(' ')).toBe(false);
  });
});
