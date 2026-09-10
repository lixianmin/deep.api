import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatAuthState } from '../../src/popup/snippet';
import { pickForensic } from '../../src/popup/snippet';
import { pickForensicTail } from '../../src/popup/snippet';

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

// 2026-09-10（feat/log-b64-export）：popup「复制取证」只输出白名单字段——
// 完整日志含 messagesFull / mirrorFull（可达 MB），而取证只需要模型原文与它的 base64。
describe('pickForensic（feat/log-b64-export）', () => {
  it('带出 base64 与现场样本字段', () => {
    const p = pickForensic({
      at: 1, version: '0.1.99', ok: false, error: 'tool call parse failed',
      replyB64: 'QUJD', rawB64: 'REVG', sseRawB64: 'R0hJ', ssePaths: ['ready', 'unknown:content'],
    });
    expect(p.rawB64).toBe('REVG');
    expect(p.replyB64).toBe('QUJD');
    expect(p.sseRawB64).toBe('R0hJ');
    expect(p.version).toBe('0.1.99');
    expect(p.ssePaths).toEqual(['ready', 'unknown:content']);
  });

  it('排除 messagesFull / mirrorFull（体积杀手）', () => {
    const p = pickForensic({ at: 1, messagesFull: 'x'.repeat(1000), mirrorFull: 'y'.repeat(1000) });
    expect(p.messagesFull).toBeUndefined();
    expect(p.mirrorFull).toBeUndefined();
    expect(p.at).toBe(1);
  });

  it('未定义输入返回空对象（不抛）', () => {
    expect(pickForensic(undefined)).toEqual({});
  });

  it('保留 falsy 但已定义的值（ok:false / ms:0），跳过 undefined', () => {
    const p = pickForensic({ ok: false, ms: 0, error: undefined });
    expect(p.ok).toBe(false);
    expect(p.ms).toBe(0);
    expect('error' in p).toBe(false);
  });
});

// 2026-09-10（fix/forensic-tail）：v0.1.100 实测取到的是「生成会话标题」辅助调用（tools:[]、
// 无 DSML），真正的聊天调用在它之前。取尾 n 条才能把整轮包住。
describe('pickForensicTail（fix/forensic-tail）', () => {
  const mk = (i: number, extra: Record<string, unknown> = {}) => ({ at: i, version: '0.1.101', ...extra });

  it('取尾部 n 条且保持时间顺序', () => {
    const out = pickForensicTail([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)], 3);
    expect(out.map((e) => e.at)).toEqual([4, 5, 6]);
  });

  it('少于 n 条时全取', () => {
    expect(pickForensicTail([mk(1), mk(2)]).map((e) => e.at)).toEqual([1, 2]);
  });

  it('空/未定义返回空数组（不抛）', () => {
    expect(pickForensicTail([])).toEqual([]);
    expect(pickForensicTail(undefined)).toEqual([]);
  });

  it('每条仍走白名单（messagesFull 不得泄入）', () => {
    const out = pickForensicTail([mk(1, { messagesFull: 'x'.repeat(10), rawB64: 'QUJD' })]);
    expect(out[0]!.messagesFull).toBeUndefined();
    expect(out[0]!.rawB64).toBe('QUJD');
  });
});

// 2026-09-10（feat/log-b64-export）：popup.ts 在模块顶层就 `getElementById(...)!.addEventListener`，
// ID 缺一个 = 打开 popup 直接 TypeError（整个弹窗不渲染）。静态比对两边 ID，防接线错位。
// jsdom 跑 popup.ts 需要 chrome/fetch/setInterval 一整套脚手架，投入产出比低——这条守的是真正会坏的环节。
describe('popup DOM 接线一致性（feat/log-b64-export）', () => {
  const here = dirname(fileURLToPath(import.meta.url));   // 锚定路径，不依赖 cwd（memory 教训）
  const src = readFileSync(join(here, '../../src/popup/popup.ts'), 'utf8');
  const html = readFileSync(join(here, '../../src/popup/popup.html'), 'utf8');

  it('popup.ts 引用的每个元素 ID 都在 popup.html 里存在', () => {
    const used = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]!);
    const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));
    expect([...new Set(used)].filter((id) => !defined.has(id))).toEqual([]);
  });

  it('「复制取证」按钮两边已接线', () => {
    expect(src).toContain("getElementById('btn-copy-forensic')");
    expect(html).toContain('id="btn-copy-forensic"');
  });
});
