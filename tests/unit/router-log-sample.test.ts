import { describe, it, expect } from 'vitest';
import { lastUserSampleOf } from '../../src/background/router';
import type { Message } from '../../src/shared/api-types';

// 2026-09-15（feat/log-copy-slim）：请求侧新增 lastUserSample 现场字段——最后一条 user 消息
// 前 200 字。此前 user 消息只在 messagesFull 全量里（UI 不显示、取证不带），排查时「模型到底
// 收到了什么问题」看不见。
describe('lastUserSampleOf（feat/log-copy-slim）', () => {
  it('取最后一条 user 消息的 content', () => {
    const msgs: Message[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答' },
      { role: 'user', content: '第二问' },
    ];
    expect(lastUserSampleOf(msgs)).toBe('第二问');
  });

  it('array content（vision）渲染成 string 再取', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '图里是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      } as unknown as Message,
    ];
    const s = lastUserSampleOf(msgs)!;
    expect(s).toContain('图里是什么');
    expect(s).not.toContain('AAAA');   // data URL 不进日志样本
  });

  it('超过 200 字截断到 200', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x'.repeat(500) }];
    expect(lastUserSampleOf(msgs)).toHaveLength(200);
  });

  it('无 user 消息 / user content 为 null 返回 undefined', () => {
    expect(lastUserSampleOf([{ role: 'assistant', content: '只有回复' }])).toBeUndefined();
    expect(lastUserSampleOf([{ role: 'user', content: null }])).toBeUndefined();
    expect(lastUserSampleOf([])).toBeUndefined();
  });
});
