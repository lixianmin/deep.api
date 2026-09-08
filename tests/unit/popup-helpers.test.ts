import { describe, it, expect } from 'vitest';
import { formatAuthState } from '../../src/popup/snippet';

describe('formatAuthState', () => {
  it('logged_in → ok', () => {
    expect(formatAuthState({ state: 'logged_in' })).toMatchObject({ label: '已登录', cls: 'ok' });
  });
  it('logged_out → bad', () => {
    expect(formatAuthState({ state: 'logged_out' }).cls).toBe('bad');
  });
  it('expired with message → warn', () => {
    const r = formatAuthState({ state: 'expired', message: 'cookie removed' });
    expect(r.cls).toBe('warn');
    expect(r.label).toContain('cookie removed');
  });
});
