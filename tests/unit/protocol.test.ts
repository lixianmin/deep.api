import { describe, it, expect } from 'vitest';
import { isBridgeRequest } from '../../src/shared/protocol';

describe('isBridgeRequest', () => {
  it('accepts valid envelope', () => {
    const v = { __deepApi: { id: 1, method: 'chat.completions.create', params: { model: 'deepseek-chat', messages: [] } } };
    expect(isBridgeRequest(v)).toBe(true);
  });
  it('rejects foreign payloads', () => {
    expect(isBridgeRequest({ hello: 1 })).toBe(false);
    expect(isBridgeRequest({ __deepApi: { id: 1, method: 'evil', params: {} } })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
  });
});
