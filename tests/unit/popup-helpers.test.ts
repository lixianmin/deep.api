import { describe, it, expect } from 'vitest';
import { formatAuthState, snippetText } from '../../src/popup/snippet';

describe('popup helpers', () => {
  it('maps auth states', () => {
    expect(formatAuthState({ state: 'logged_in' })).toMatchObject({ label: '已登录', cls: 'ok' });
    expect(formatAuthState({ state: 'logged_out' }).cls).toBe('bad');
    expect(formatAuthState({ state: 'expired', message: 'x' }).cls).toBe('warn');
  });
  it('builds snippet with key', () => {
    const s = snippetText('sk-dapi-abc');
    expect(s).toContain('sk-dapi-abc');
    expect(s).toContain('deepApi.chat.completions.create');
  });
});
