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
});
