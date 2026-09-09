import { describe, it, expect } from 'vitest';
import { parseSseText, extractReadyIds, ResponseTree, completionEvents } from '../../src/background/providers/deepseek/sse-patch';
import type { ProviderStreamEvent } from '../../src/background/providers/adapter';

// 合成片段（fixture 就绪后替换为 sse-normal.json 内容，结构同型）
const synthetic = [
  'event: chunk\ndata: {"response/status":{"op":"replace","path":"response/status","value":"ready"}}\n\n',
  'event: chunk\ndata: {"response/fragments":{"op":"add","path":"response/fragments","value":{"id":1,"type":"think","content":""}}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"思考中"}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"结束"}}\n\n',
  'event: chunk\ndata: {"response/fragments":{"op":"add","path":"response/fragments","value":{"id":2,"type":"response","content":""}}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"你好"}}\n\n',
  'event: chunk\ndata: {"response/accumulated_token_usage":{"op":"replace","path":"response/accumulated_token_usage","value":17}}\n\n',
].join('');

describe('parseSseText', () => {
  it('splits events and keeps data', () => {
    const evs = parseSseText(synthetic);
    expect(evs.length).toBe(7);
    expect(evs[0]!.data).toContain('response/status');
  });
});
describe('ResponseTree', () => {
  it('emits think deltas, content deltas, then usage', () => {
    const tree = new ResponseTree();
    const out: ProviderStreamEvent[] = [];
    for (const { data } of parseSseText(synthetic)) {
      // 与 completionEvents 相同路径：把信封解包为单 op 再 apply
      const env = JSON.parse(data) as Record<string, { op: string; path: string; value?: unknown }>;
      for (const [path, v] of Object.entries(env)) {
        out.push(...tree.apply({ op: v.op, path: v.path ?? path, value: v.value }));
      }
    }
    expect(out.map(e => e.kind)).toEqual(['think_delta','think_delta','content_delta','usage']);
    expect(out[0]).toMatchObject({ kind: 'think_delta', content: '思考中' });
    expect(out[2]).toMatchObject({ kind: 'content_delta', content: '你好' });
    expect(out[3]).toMatchObject({ kind: 'usage', outputTokens: 17 });
  });

  // 2026-09-09（fix/snapshot-fragments）：v0.1.76 用户实测 Pro（expert）sseRaw 现场：
  // {"v":{"response":{"fragments":[{"id":2,"type":"TIP","content":"专家模式暂不支持搜索…"},
  // {"id":3,"type":"RESPONSE","content":"这是一个","references":[],"stage_id":2}]}}}
  // ——内容在嵌套快照里，sse-patch 的形态3 把这当「快照跳过」，fragments 没进 tree 上下文，
  // 后续 response/fragments/-1/content 增量也因 frag 不存在被丢弃 → replySample 空。
  // 修：ResponseTree.applySnapshot 解析 {"v":{"response":{"fragments":[...]}}}，
  // RESPONSE→content_delta、THINK/THINKING→think_delta、TIP 等其它 type 跳过；
  // 并把 fragments 推进 tree.fragments 供后续 /-1/content 增量接续。
  it('applies nested snapshot fragments: RESPONSE→content, THINK→thinking, TIP 跳过', () => {
    const tree = new ResponseTree();
    const data = {
      v: {
        response: {
          fragments: [
            { id: 2, type: 'TIP', content: '专家模式暂不支持搜索，请使用快速模式', style: 'INFO' },
            { id: 3, type: 'RESPONSE', content: '这是一个', references: [], stage_id: 2 },
            { id: 4, type: 'THINK', content: '先想想', stage_id: 3 },
          ],
        },
      },
    };
    const out = tree.applySnapshot(data as never);
    expect(out.map(e => e.kind)).toEqual(['content_delta', 'think_delta']);
    expect(out[0]).toMatchObject({ kind: 'content_delta', content: '这是一个' });
    expect(out[1]).toMatchObject({ kind: 'think_delta', content: '先想想' });
    // 增量接续：快照后的 /-1/content 能接到最后 frag（THINK）上
    const more = tree.apply({ op: 'APPEND', path: 'response/fragments/-1/content', value: '中' });
    expect(more).toEqual([{ kind: 'think_delta', content: '中' }]);
  });
});
describe('extractReadyIds', () => {
  it('extracts message ids', () => {
    const ids = extractReadyIds({ request_message_id: 123, response_message_id: 456, message_id: 456 });
    expect(ids).toEqual({ requestMessageId: 123, responseMessageId: 456 });
  });
});
describe('completionEvents', () => {
  it('streams chunks split across boundaries', async () => {
    const enc = new TextEncoder();
    const chunks = synthetic.match(/.{1,40}/gs)!.map(s => enc.encode(s));
    const evs: string[] = [];
    for await (const e of completionEvents(async function* () { for (const c of chunks) yield c; }(), 10_000, () => {})) {
      evs.push(e.kind);
    }
    expect(evs.filter(k => k === 'content_delta' || k === 'think_delta' || k === 'usage')).toHaveLength(4);
  });
  it('aborts with error when the body stalls beyond timeout', async () => {
    // 真实短定时器（避免 fake timers 干扰；根因见 fix report：finally 不得 await 未决源的 return()）
    const stalled = (async function* () { await new Promise(() => {}); })();
    const it = completionEvents(stalled, 100, () => {})[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/no progress/);
  });
  it('parses a trailing frame without a final blank line', async () => {
    const enc = new TextEncoder();
    const head = 'event: chunk\ndata: {"response/fragments":{"op":"add","path":"response/fragments","value":{"id":9,"type":"response","content":""}}}\n\n';
    const tail = 'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"尾帧"}}';
    const evs: ProviderStreamEvent[] = [];
    for await (const e of completionEvents(async function* () { yield enc.encode(head); yield enc.encode(tail); }(), 10_000, () => {})) evs.push(e);
    expect(evs.some(e => e.kind === 'content_delta' && e.content === '尾帧')).toBe(true);
  });
});

// ===== 真实 SSE 格式（2026-09 实测 chat.deepseek.com）=====
// 完整操作 {"p":"response/content","o":"APPEND","v":"你好"} + 连续增量 {"v":"！"}(继承 p/o) + usage + status
const realSse = [
  'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n',
  'data: {"v":{"response":{"message_id":2,"parent_id":1,"status":"WIP","content":""}}}\n\n',
  'data: {"p":"response/content","o":"APPEND","v":"你好"}\n\n',
  'data: {"v":"！"}\n\n',
  'data: {"v":"😊"}\n\n',
  'data: {"p":"response/accumulated_token_usage","o":"SET","v":66}\n\n',
  'data: {"p":"response/status","v":"FINISHED"}\n\n',
  'event: finish\ndata: {}\n\n',
].join('');

describe('completionEvents (真实 SSE 格式 p/o/v)', () => {
  async function collect(): Promise<ProviderStreamEvent[]> {
    const chunks: Uint8Array[] = [];
    for (const block of realSse.split('\n\n')) {
      chunks.push(new TextEncoder().encode(block + '\n\n'));
    }
    const iter = (async function* () { for (const c of chunks) yield c; })();
    const out: ProviderStreamEvent[] = [];
    for await (const ev of completionEvents(iter, 1000, () => {})) out.push(ev);
    return out;
  }
  it('parses content deltas, inherits shorthand increments, emits usage', async () => {
    const evs = await collect();
    const content = evs.filter(e => e.kind === 'content_delta').map(e => e.content).join('');
    expect(content).toBe('你好！😊');
    // message_id 从 ready 事件提取
    const msgIds = evs.filter(e => e.kind === 'message_id').map(e => (e as any).id);
    expect(msgIds).toContain(2);
    // usage 事件
    const usage = evs.filter(e => e.kind === 'usage').map(e => (e as any).outputTokens);
    expect(usage).toContain(66);
  });

  // 2026-09-09（diag/raw-sample）：v0.1.71/72 实测 Pro（model_type=expert）在网页 web API 上
  // 返回 sseBytes≈320 + paths 只含 ['ready','unknown:unknown','unknown:type','unknown:click_behavior']，
  // 0 content 0 thinking；Flash 正常返回 response/content。
  // 光有 paths 不够——需要原始 SSE 文本来确定这 3 个 unknown 事件到底是什么。
  // 修：completionEvents 流末 stream_stats 携带 rawSample（前 600 字符原始 SSE 文本），
  // log 透出后可读真实事件内容。
  it('analyze: stream_stats 携带 rawSample（前 600 字符原始 SSE 文本）', async () => {
    const proSse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}\n\n',
      'data: {"unknown":"xxx"}\n\n',
      'data: {"type":"click_behavior","count":1}\n\n',
      'data: {"click_behavior":{"enabled":true}}\n\n',
    ].join('');
    const chunks: Uint8Array[] = [];
    for (const block of proSse.split('\n\n')) chunks.push(new TextEncoder().encode(block + '\n\n'));
    const iter = (async function* () { for (const c of chunks) yield c; })();
    const evs: ProviderStreamEvent[] = [];
    for await (const ev of completionEvents(iter, 1000, () => {})) evs.push(ev);
    const stats = evs.find(e => e.kind === 'stream_stats') as any;
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.paths).toContain('unknown:type');
    expect(stats.rawSample).toContain('click_behavior');
    expect(stats.rawSample).toContain('"unknown":"xxx"');
  });
});
