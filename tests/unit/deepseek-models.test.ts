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
    expect(resolveModel('deepseek-v4-flash-vision-exp')).toMatchObject({ modelType: 'vision', thinking: true });
  });
  // 2026-09-09（fix/pro-thinking-default）：Pro（model_type=expert）在 DeepSeek 网页 web API 上
  // setting thinking_enabled=true 会进入「只思考不说话」路径——B-3 现场：sseBytes=320（遥测+ ready）
  // 0 个 response/content 或 response/thinking_content，finishReason=stop。修：Pro 默认 thinking=false
  // 走直答路径，跟 Flash 一致在 web 上有效。记忆里“所有模型默认 thinking=true”（v0.1.35）只对 Flash
  // 测过，Pro 在 web 上验证后必须 override。
  it('fail-to-pass: Pro 默认 thinking=false（避免 web API 上「只思考不说话」B-3）', () => {
    expect(resolveModel('deepseek-v4-pro')).toMatchObject({ modelType: 'expert', thinking: false });
    expect(resolveModel('gpt-4o')).toBeNull();
  });
});
