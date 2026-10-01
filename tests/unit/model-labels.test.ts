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
  it('returns null for unknown labels', () => {
    expect(labelToModelId('Some Future Model')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(labelToModelId('')).toBeNull();
  });
});
