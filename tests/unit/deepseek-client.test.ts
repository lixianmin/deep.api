import { describe, it, expect } from 'vitest';
import { completionPayload, MODELS, resolveModel } from '../../src/background/providers/deepseek/client';

describe('deepseek client', () => {
  describe('completionPayload', () => {
    const session = { providerId: 'deepseek', webSessionId: 'sess-1', parentMessageId: 'msg-0' };

    it('uses model defaults when no overrides', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: false });
      expect(p.thinking_enabled).toBe(false);
      expect(p.search_enabled).toBe(false);
      expect(p).not.toHaveProperty('reasoning_effort');
    });

    it('uses model default thinking when override is undefined', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true });
      expect(p.thinking_enabled).toBe(true);
    });

    it('explicit true overrides default off', () => {
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
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: false }, { search: true });
      expect(p.search_enabled).toBe(true);
    });

    it('omits reasoning_effort when not set', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true });
      expect(p).not.toHaveProperty('reasoning_effort');
    });

    it('passes reasoning_effort through', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { reasoningEffort: 'high' });
      expect(p.reasoning_effort).toBe('high');
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

    it('resolves flash and pro with distinct modelType/thinking defaults', () => {
      const flash = resolveModel('deepseek-v4-flash')!;
      const pro = resolveModel('deepseek-v4-pro')!;
      expect(flash.modelType).toBe('default');
      expect(pro.modelType).toBe('expert');
      // flash 默认 thinking=false（保守不自动开），调用方传 thinking:true 才打开
      expect(flash.thinking).toBe(false);
      expect(pro.thinking).toBe(true);
    });

    it('lists three models including vision', () => {
      const ids = MODELS.map(m => m.id);
      expect(ids).toContain('deepseek-v4-flash');
      expect(ids).toContain('deepseek-v4-pro');
      expect(ids).toContain('deepseek-v4-flash-vision-exp');
    });
  });
});
