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

    it('resolves flash/vision thinking=true, pro thinking=false（web API 上 Pro 走直答避免 B-3）', () => {
      const flash = resolveModel('deepseek-v4-flash')!;
      const pro = resolveModel('deepseek-v4-pro')!;
      const vision = resolveModel('deepseek-v4-flash-vision-exp')!;
      expect(flash.modelType).toBe('default');
      expect(pro.modelType).toBe('expert');
      expect(vision.modelType).toBe('vision');
      // 2026-09-09（fix/pro-thinking-default）：v0.1.35 假设「所有模型 thinking=true」在 web API 上
      // 只对 Flash 测过。Pro 在 chat.deepseek.com/api/v0 上 thinking_enabled=true 会进入
      // 「只思考不说话」路径，0 content 返回——实证 sseBytes≈320/0 response_content。
      // 修：Pro 默认 false；Flash / vision 保持 true（与官方默认对齐）。
      expect(flash.thinking).toBe(true);
      expect(pro.thinking).toBe(false);
      expect(vision.thinking).toBe(true);
    });

    it('lists three models including vision', () => {
      const ids = MODELS.map(m => m.id);
      expect(ids).toContain('deepseek-v4-flash');
      expect(ids).toContain('deepseek-v4-pro');
      expect(ids).toContain('deepseek-v4-flash-vision-exp');
    });
  });
});
