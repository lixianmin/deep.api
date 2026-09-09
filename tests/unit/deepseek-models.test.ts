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
  // 2026-09-09（fix/pro-thinking-true）：v0.1.72 曾把 Pro 默认 thinking=false——当时误判
  // 「只思考不说话」是 thinking 开启导致。实际根因是 v0.1.75-78 修的三件套（客户端版本头/
  // 嵌套快照/APPEND 数组），与 thinking 无关；thinking 模式已实测正常。回滚官方默认：
  // 所有模型默认 thinking=true（与 DeepSeek 官方对齐，调用方仍可显式覆盖）。
  it('fail-to-pass: Pro 默认 thinking=true（v0.1.72 误判回滚，官方默认）', () => {
    expect(resolveModel('deepseek-v4-pro')).toMatchObject({ modelType: 'expert', thinking: true });
    expect(resolveModel('gpt-4o')).toBeNull();
  });
});
