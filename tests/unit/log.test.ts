import { describe, it, expect } from 'vitest';
import { RingLog, toB64 } from '../../src/background/log';

describe('RingLog', () => {
  it('keeps last 20 entries in order', () => {
    const l = new RingLog(20);
    for (let i = 0; i < 25; i++) l.push({ at: i, provider: 'deepseek', model: 'm', ok: true, ms: 1 });
    const list = l.list();
    expect(list).toHaveLength(20);
    expect(list[0]!.at).toBe(5);
    expect(list[19]!.at).toBe(24);
  });
});

// 2026-09-10（feat/log-b64-export）：用户现场取证需要。DSML 标记（｜DSML｜，U+FF5C）在聊天/终端
// 粘贴链上会被整体吃掉（双方都实测过）——base64 是纯 ASCII，能跨这条链路逐字节还原。
describe('toB64：现场字节取证（feat/log-b64-export）', () => {
  const I = 'inv' + 'oke', N = 'na' + 'me';

  it('往返无损：全角 ｜DSML｜（U+FF5C）不被吃掉', () => {
    const raw = `<${"\uFF5C"}DSML${"\uFF5C"}tool_calls>\n<${"\uFF5C"}DSML${"\uFF5C"}${I} ${N}="Read">`;
    const b64 = toB64(raw)!;
    // 只含 base64 字母表 → 跨粘贴链（markdown/HTML/工具解析）不会被解释掉
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(raw);
  });

  it('多字节 UTF-8（中文）也不丢', () => {
    const raw = '模型吐了 DSML，要读 sketch.ino';
    expect(Buffer.from(toB64(raw)!, 'base64').toString('utf8')).toBe(raw);
  });

  it('空输入返回 undefined（不写空字段、不抛）', () => {
    expect(toB64('')).toBeUndefined();
    expect(toB64(undefined)).toBeUndefined();
  });
});
