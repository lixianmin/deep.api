import { describe, it, expect, vi } from 'vitest';
import { extractImageRefs, renderMessageContent, type ImageRef } from '../../src/background/vision-pipeline';

describe('extractImageRefs', () => {
  it('returns empty for string content', () => {
    expect(extractImageRefs({ role: 'user', content: 'hello' })).toEqual([]);
  });

  it('returns empty for null content', () => {
    expect(extractImageRefs({ role: 'user', content: null })).toEqual([]);
  });

  it('returns empty for array without image_url', () => {
    expect(extractImageRefs({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
  });

  // 2026-09-09（feat/vision-multimodal）：spike #2 用户真实 curl 现场：data URL
  // `data:image/png;base64,iVBOR...`，image_url 块含 detail（可选）。
  it('extracts data URL image_url with mime type', () => {
    const refs = extractImageRefs({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.isDataUrl).toBe(true);
    expect(refs[0]!.mimeType).toBe('image/png');
    expect(refs[0]!.url).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('extracts http(s) URL image_url (no mime — 下载后探测)', () => {
    const refs = extractImageRefs({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.isDataUrl).toBe(false);
    expect(refs[0]!.mimeType).toBeUndefined();
    expect(refs[0]!.url).toBe('https://example.com/cat.jpg');
  });

  it('extracts mixed content array (text + image 多个)', () => {
    const refs = extractImageRefs({
      role: 'user',
      content: [
        { type: 'text', text: '看这两张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
        { type: 'image_url', image_url: { url: 'https://x.com/2.jpg' } },
      ],
    });
    expect(refs).toHaveLength(2);
    expect(refs[0]!.isDataUrl).toBe(true);
    expect(refs[1]!.isDataUrl).toBe(false);
  });

  it('skips malformed image_url blocks (缺 image_url.url)', () => {
    expect(extractImageRefs({
      role: 'user',
      content: [{ type: 'image_url' } as never],
    })).toEqual([]);
  });

  it('defaults mime to image/png for malformed data URL prefix', () => {
    const refs = extractImageRefs({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:;base64,xxx' } }],
    });
    expect(refs[0]!.mimeType).toBe('image/png');
  });
});

describe('renderMessageContent', () => {
  it('passes string content through unchanged', () => {
    expect(renderMessageContent({ role: 'user', content: 'hello world' })).toBe('hello world');
  });

  it('returns empty string for null content', () => {
    expect(renderMessageContent({ role: 'user', content: null })).toBe('');
  });

  // 2026-09-09（feat/vision-multimodal）：对齐 llmweb2api renderMessageBlock——
  // text 块保留文本，image_url 块替换为 `[image]` 占位符。prompt 文本携带位置 + ref_file_ids
  // 携带实际图片（服务端用 ref_file_ids 拿图）。
  it('keeps text blocks and replaces image_url with [image]', () => {
    expect(renderMessageContent({
      role: 'user',
      content: [
        { type: 'text', text: '电路图有故障吗' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ],
    })).toBe('电路图有故障吗[image]');
  });

  it('only-image content produces [image] placeholder', () => {
    expect(renderMessageContent({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:...' } }],
    })).toBe('[image]');
  });

  it('only-text content produces plain text (no placeholder)', () => {
    expect(renderMessageContent({
      role: 'user',
      content: [{ type: 'text', text: '只看图但其实没图' }],
    })).toBe('只看图但其实没图');
  });

  it('preserves multiple text blocks in order', () => {
    expect(renderMessageContent({
      role: 'user',
      content: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'text', text: 'C' },
      ],
    })).toBe('AB[image]C');
  });
});

// 保留 helper type 给 adapter 测试复用（不导出避免污染 API）
export type _ImageRefTest = ImageRef;