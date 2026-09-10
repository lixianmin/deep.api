import type { ContentBlock, Message } from '../shared/api-types';

/** 抽取后的图片引用。data URL 直接带 mime；HTTP URL 在下载后探测 content-type。 */
export interface ImageRef {
  url: string;
  isDataUrl: boolean;
  mimeType?: string;
}

/** 从 user message content 中抽 image_url 块（OpenAI 兼容格式）。
 *  - string content → []
 *  - null content → []
 *  - array content：遍历找 type='image_url' 且 image_url.url 存在的块
 *  - data URL 解析 data:xxx;base64 中的 xxx 作为 mime（解析失败默认 image/png）
 */
export function extractImageRefs(msg: Pick<Message, 'content'>): ImageRef[] {
  const c = msg.content;
  if (!c || typeof c === 'string') return [];
  if (!Array.isArray(c)) return [];
  const out: ImageRef[] = [];
  for (const block of c as ContentBlock[]) {
    if (block.type !== 'image_url') continue;
    const url = block.image_url?.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (url.startsWith('data:')) {
      const m = url.match(/data:([^;]+);base64/);
      out.push({ url, isDataUrl: true, mimeType: m?.[1] || 'image/png' });
    } else {
      out.push({ url, isDataUrl: false });
    }
  }
  return out;
}

/** 把 message.content 渲染成 DeepSeek prompt 用的纯文本字符串。
 *  - string → 原样
 *  - null → ''
 *  - array：text 块 → text 拼接；image_url 块 → `[image]` 占位符
 *  （对齐 llmweb2api renderMessageBlock：ref_file_ids 携带实际图，prompt 文本携带位置）
 */
export function renderMessageContent(msg: Pick<Message, 'content'>): string {
  const c = msg.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  let out = '';
  for (const block of c as ContentBlock[]) {
    if (block.type === 'text') out += block.text;
    else if (block.type === 'image_url') out += '[image]';
  }
  return out;
}