import { describe, it, expect } from 'vitest';
import { MODELS, resolveModel } from '../../src/background/providers/deepseek/client';

describe('DeepSeek model registry (2026-09-14 fix/models-v4-retired: V4 retired → 1 chat model + 1 vision)', () => {
  it('exposes the single live chat model: deepseek-flash (V4.1 unified)', () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toEqual(['deepseek-flash']);
  });

  it('resolves deepseek-flash → vision + thinking=true; deepseek-v4-flash-vision-exp → vision (compat layer)', () => {
    // 2026-09-10（fix/vision-button）：V4.1 Flash 统一后所有 chat 调都走 vision pipeline
    // （服务端路由到 V4.1 Flash，支持 image_url）。所以 modelType 改为 'vision'。
    expect(resolveModel('deepseek-flash')).toMatchObject({ modelType: 'vision', thinking: true });
    expect(resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', thinking: true });
    // 2026-09-14（fix/accept-v4-flash-alias）：旧 chat ID `deepseek-v4-flash` 仍被 DeepSeek
    // API 兼容层接受（路由到 V4.1 Flash）——恢复兼容解析，行为与 `deepseek-flash` 完全一致。
    expect(resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'vision', thinking: true, limitChars: 2_621_440 });
    // 仍未恢复的旧 ID：
    expect(resolveModel('deepseek-v4-pro')).toBeNull();
    expect(resolveModel('gpt-4o')).toBeNull();
  });
});
