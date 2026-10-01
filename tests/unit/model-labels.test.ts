import { describe, it, expect } from 'vitest';
import { labelToModelId } from '../../src/shared/model-labels';

describe('labelToModelId', () => {
  it('maps "default" → "deepseek-flash"（V4.1 统一后 UI 默认文案）', () => {
    expect(labelToModelId('default')).toBe('deepseek-flash');
  });
  it('maps "DeepSeek V4.1 Flash" → "deepseek-flash"（V4.1 完整标签）', () => {
    expect(labelToModelId('DeepSeek V4.1 Flash')).toBe('deepseek-flash');
  });
  it('maps "DeepSeek V4 Flash Vision Exp" → "deepseek-v4-flash-vision-exp"（retired 兼容）', () => {
    expect(labelToModelId('DeepSeek V4 Flash Vision Exp')).toBe('deepseek-v4-flash-vision-exp');
  });
  it('maps "DeepSeek V4 Pro" → "deepseek-v4-pro"（retired 兼容）', () => {
    expect(labelToModelId('DeepSeek V4 Pro')).toBe('deepseek-v4-pro');
  });
  // 2026-10-01（test/regexp4-coverage）：第 4 条正则 /deepseek\s*v4\s*flash/i 的直接覆盖。
  // 此前无任何用例触达它——含 "1" 的文案被第 1 条拦下，vision/pro 被第 2/3 条拦下，
  // 只有「V4 Flash」这种缺 "1" 的形态才会落到第 4 条，故此处专门钉住该分支。
  it('maps "DeepSeek V4 Flash" → "deepseek-flash"（缺 "1" 形态，落到第 4 条兜底）', () => {
    expect(labelToModelId('DeepSeek V4 Flash')).toBe('deepseek-flash');
  });
  it('returns null for unknown labels', () => {
    expect(labelToModelId('Some Future Model')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(labelToModelId('')).toBeNull();
  });
});
