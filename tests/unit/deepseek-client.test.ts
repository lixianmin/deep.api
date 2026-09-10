import { describe, it, expect } from 'vitest';
import { completionPayload, MODELS, resolveModel } from '../../src/background/providers/deepseek/client';

describe('deepseek client', () => {
  describe('completionPayload', () => {
    const session = { providerId: 'deepseek', webSessionId: 'sess-1', parentMessageId: 'msg-0' };

    it('defaults to thinking=true and reasoning_effort=high (matches DeepSeek official default)', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true });
      expect(p.thinking_enabled).toBe(true);
      expect(p.search_enabled).toBe(false);
      expect(p.reasoning_effort).toBe('high');
    });

    it('uses model default thinking when override is undefined', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true });
      expect(p.thinking_enabled).toBe(true);
    });

    it('explicit true overrides default off (rare; only when caller sets model.thinking=false)', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: false }, { thinking: true });
      expect(p.thinking_enabled).toBe(true);
    });

    it('explicit false overrides default on', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { thinking: false });
      expect(p.thinking_enabled).toBe(false);
    });

    it('null thinking treated as explicit off', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { thinking: null });
      expect(p.thinking_enabled).toBe(false);
    });

    it('passes search_enabled=true', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { search: true });
      expect(p.search_enabled).toBe(true);
    });

    it('default reasoning_effort is high when not overridden', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true });
      expect(p.reasoning_effort).toBe('high');
    });

    it('passes reasoning_effort override through', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { reasoningEffort: 'low' });
      expect(p.reasoning_effort).toBe('low');
    });

    it('preserves session/prompt fields', () => {
      const p = completionPayload(session, 'hello', { modelType: 'expert', thinking: true });
      expect(p.chat_session_id).toBe('sess-1');
      expect(p.parent_message_id).toBe('msg-0');
      expect(p.model_type).toBe('expert');
      expect(p.prompt).toBe('hello');
      expect(p.preempt).toBe(false);
    });
  });

  describe('resolveModel / MODELS', () => {
    it('returns null for unknown model', () => {
      expect(resolveModel('unknown')).toBeNull();
    });

    it('resolves chat/vision 默认 thinking=true（V4.1 Flash 统一后 + vision 兼容）', () => {
      const flash = resolveModel('deepseek-flash')!;
      const vision = resolveModel('deepseek-v4-flash-vision-exp')!;
      // 2026-09-10（fix/vision-button）：V4.1 Flash 统一后所有 chat 调都走 vision pipeline
      // （服务端路由到 V4.1 Flash，支持 image_url）。所以 modelType 改为 'vision'。
      expect(flash.modelType).toBe('vision');
      expect(vision.modelType).toBe('vision');
      // 2026-09-09（fix/pro-thinking-true）：v0.1.72 误判「thinking_enabled=true 会让 Pro 只思考
      // 不说话」——实际根因是客户端版本头缺失 + 嵌套快照/APPEND 数组未解析（v0.1.75-78 已修），
      // 与 thinking 无关。thinking 模式实测正常（reasoningSample+replySample 都有）。
      // 回滚：所有模型默认 thinking=true（与官方默认对齐）。调用方仍可显式覆盖。
      expect(flash.thinking).toBe(true);
      expect(vision.thinking).toBe(true);
      // 2026-09-14（fix/accept-v4-flash-alias）：`deepseek-v4-flash` 恢复兼容解析（与
      // `deepseek-flash` 同配置），但**不**进 MODELS（模型列表仍只 1 项）。
      expect(resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'vision', thinking: true });
      // 仍未恢复的旧 ID → null
      expect(resolveModel('deepseek-v4-pro')).toBeNull();
    });

    it('lists single live chat model: deepseek-flash', () => {
      const ids = MODELS.map((m) => m.id);
      expect(ids).toEqual(['deepseek-flash']);
    });
  });
});
