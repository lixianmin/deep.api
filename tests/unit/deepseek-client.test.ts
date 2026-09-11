import { describe, it, expect } from 'vitest';
import { completionPayload, MODELS, resolveModel } from '../../src/background/providers/deepseek/client';

describe('deepseek client', () => {
  describe('completionPayload', () => {
    const session = { providerId: 'deepseek', webSessionId: 'sess-1', parentMessageId: 'msg-0' };

    // 2026-09-11（feat/reasoning-search-alignment）：硬切到 pi-ai 对齐的 `reasoning` 单字段。
    // 老 `thinking: bool` + `reasoning_effort: string` 两字段契约废止。spec §3.2 映射表。

    it('reasoning=undefined → 模型默认（thinking=true, reasoning_effort=high）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('high');
    });

    it('reasoning=undefined + model.thinking=false → thinking_enabled=false', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: false });
      expect(p.thinking_enabled).toBe(false);
      // reasoning_effort 仍按 high 发送（与改前行为一致——模型层默认 high 不受 caller 影响）
      expect(p.reasoning_effort).toBe('high');
    });

    it('reasoning="off" → 请求体不含 thinking_enabled 和 reasoning_effort（字段缺席）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { reasoning: 'off' });
      expect('thinking_enabled' in p).toBe(false);
      expect('reasoning_effort' in p).toBe(false);
    });

    it('reasoning="off" + search=true → search 仍按 caller 透传（互不干扰）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { reasoning: 'off', search: true });
      expect('thinking_enabled' in p).toBe(false);
      expect('reasoning_effort' in p).toBe(false);
      expect(p.search_enabled).toBe(true);
    });

    it('reasoning="low" → thinking_enabled=true, reasoning_effort="low"', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { reasoning: 'low' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('low');
    });

    it('reasoning="high" → thinking_enabled=true, reasoning_effort="high"', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { reasoning: 'high' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('high');
    });

    it('reasoning="max" → thinking_enabled=true, reasoning_effort="max"', () => {
      const p = completionPayload(session, 'hi', { modelType: 'expert', thinking: true }, { reasoning: 'max' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('max');
    });

    it('reasoning="minimal" → 折叠为 reasoning_effort="low"（DeepSeek 不接受 minimal）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { reasoning: 'minimal' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('low');
    });

    it('reasoning="medium" → 折叠为 reasoning_effort="high"（DeepSeek 不接受 medium）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { reasoning: 'medium' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('high');
    });

    it('reasoning="xhigh" → 折叠为 reasoning_effort="high"（DeepSeek 不接受 xhigh）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { reasoning: 'xhigh' });
      expect(p.thinking_enabled).toBe(true);
      expect(p.reasoning_effort).toBe('high');
    });

    // search 字段（deep.api 独家保留）—— 行为不变
    it('search=true → search_enabled=true', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { search: true });
      expect(p.search_enabled).toBe(true);
    });

    it('search=undefined → search_enabled=false（默认 off）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true });
      expect(p.search_enabled).toBe(false);
    });

    it('search=false → search_enabled=false', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true }, { search: false });
      expect(p.search_enabled).toBe(false);
    });

    // 结构字段（与改前一致）
    it('preserves session/prompt fields', () => {
      const p = completionPayload(session, 'hello', { modelType: 'expert', thinking: true });
      expect(p.chat_session_id).toBe('sess-1');
      expect(p.parent_message_id).toBe('msg-0');
      expect(p.model_type).toBe('expert');
      expect(p.prompt).toBe('hello');
      expect(p.preempt).toBe(false);
      expect(p.action).toBe(null);
    });

    it('preserves ref_file_ids when provided', () => {
      const p = completionPayload(session, 'hi', { modelType: 'vision', thinking: true }, undefined, ['f-1', 'f-2']);
      expect(p.ref_file_ids).toEqual(['f-1', 'f-2']);
    });

    it('ref_file_ids 默认空数组（不是 undefined）', () => {
      const p = completionPayload(session, 'hi', { modelType: 'default', thinking: true });
      expect(p.ref_file_ids).toEqual([]);
    });
  });

  describe('resolveModel / MODELS', () => {
    it('returns null for unknown model', () => {
      expect(resolveModel('unknown')).toBeNull();
    });

    it('resolves chat/vision 默认 thinking=true（V4.1 Flash 统一后 + vision 兼容）', () => {
      const flash = resolveModel('deepseek-flash')!;
      const vision = resolveModel('deepseek-v4-flash-vision-exp')!;
      // 2026-09-10（fix/vision-model-type）：图片不再需要 wire model_type='vision'——网页端带图
      // 请求用 model_type='default' + ref_file_ids，而 model_type='vision' 会路由到用 DSML
      // 工具调用格式的 vision 变体（下游解析不了）。图片能力改由独立字段 supportsImages 表达。
      expect(flash.modelType).toBe('default');
      expect(flash.supportsImages).toBe(true);
      expect(vision.modelType).toBe('vision');
      expect(vision.supportsImages).toBe(true);
      // 2026-09-09（fix/pro-thinking-true）：v0.1.72 误判「thinking_enabled=true 会让 Pro 只思考
      // 不说话」——实际根因是客户端版本头缺失 + 嵌套快照/APPEND 数组未解析（v0.1.75-78 已修），
      // 与 thinking 无关。thinking 模式实测正常（reasoningSample+replySample 都有）。
      // 回滚：所有模型默认 thinking=true（与官方默认对齐）。调用方仍可显式覆盖。
      expect(flash.thinking).toBe(true);
      expect(vision.thinking).toBe(true);
      // 2026-09-14（fix/accept-v4-flash-alias）：`deepseek-v4-flash` 恢复兼容解析（与
      // `deepseek-flash` 同配置），但**不**进 MODELS（模型列表仍只 1 项）。
      expect(resolveModel('deepseek-v4-flash')).toMatchObject({ modelType: 'default', supportsImages: true, thinking: true });
      // 仍未恢复的旧 ID → null
      expect(resolveModel('deepseek-v4-pro')).toBeNull();
    });

    it('lists single live chat model: deepseek-flash', () => {
      const ids = MODELS.map((m) => m.id);
      expect(ids).toEqual(['deepseek-flash']);
    });
  });
});
