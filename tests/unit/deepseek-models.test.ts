import { describe, it, expect } from 'vitest';
import { MODELS, resolveModel } from '../../src/background/providers/deepseek/client';

describe('DeepSeek model registry', () => {
  it('exposes current public models from api-docs.deepseek.com', () => {
    const ids = MODELS.map(m => m.id);
    expect(ids).toContain('deepseek-v4-flash');
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('deepseek-v4-flash-vision-exp');
  });

  it('resolves public model ids to internal web model types', () => {
    expect(resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'default', thinking: true });
    expect(resolveModel('deepseek-v4-pro')).toMatchObject({ modelType: 'expert', thinking: true });
    expect(resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', thinking: true });
    expect(resolveModel('gpt-4o')).toBeNull();
  });
});
