import { describe, it, expect } from 'vitest';
import { sseChunkFrame, sseErrorFrame, sseDoneFrame } from '../../src/content/bridge-main';
import type { ChatCompletionChunk } from '../../src/shared/api-types';

describe('bridge-main SSE frame helpers (v0.1.45)', () => {
  it('sseChunkFrame wraps a chunk as "data: {json}\\n\\n"', () => {
    const c: ChatCompletionChunk = {
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }],
    };
    const f = sseChunkFrame(c);
    expect(f).toBe('data: ' + JSON.stringify(c) + '\n\n');
  });

  it('sseDoneFrame is exactly "data: [DONE]\\n\\n"', () => {
    expect(sseDoneFrame()).toBe('data: [DONE]\n\n');
  });

  it('sseErrorFrame wraps the error body so consumer can detect failure', () => {
    const f = sseErrorFrame({ error: { message: '网络中断', code: 'provider_unavailable' } });
    expect(f).toBe('data: ' + JSON.stringify({ error: { message: '网络中断', code: 'provider_unavailable' } }) + '\n\n');
  });

  it('sseErrorFrame falls back to unknown error when body is missing', () => {
    const f = sseErrorFrame({});
    const parsed = JSON.parse(f.replace(/^data: /, '').trim());
    expect(parsed.error.message).toBe('unknown');
    expect(parsed.error.code).toBe('internal_error');
  });

  it('OpenAI SSE 契约：所有帧以 \\n\\n 结尾，data: 行是单个 JSON 对象或 [DONE] 哨兵', () => {
    const c: ChatCompletionChunk = {
      id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm',
      choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }],
    };
    const frames = [sseChunkFrame(c), sseErrorFrame({ error: { message: 'x', code: 'y' } }), sseDoneFrame()];
    for (const f of frames) {
      expect(f.endsWith('\n\n')).toBe(true);
      expect(f.startsWith('data: ')).toBe(true);
      const data = f.slice(6, -2);  // 去 'data: ' 前缀和 '\n\n' 后缀
      // [DONE] 是 OpenAI 哨兵（不是 JSON）；其他帧必须是单个 JSON 对象
      if (data === '[DONE]') continue;
      expect(() => JSON.parse(data)).not.toThrow();
    }
  });
});
