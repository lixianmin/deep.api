import { describe, it, expect } from 'vitest';
import { PowSolver, PowFailedError, type WasmInstance } from '../../src/background/providers/deepseek/pow';

// fake wasm：模拟真实 wasm 的返回值约定（对照 RezaParsian/DeepseekPowsolver 实测）：
// status(i32)@0 + answer(f64)@8；status=1 成功、0 失败
function fakeWasm(answer: number, hasSignature = true): WasmInstance {
  const mem = new Uint8Array(4096);
  const dv = new DataView(mem.buffer);
  let stackPtr = 2048;
  let cursor = 256;
  return {
    addToStack: (n: number) => { stackPtr += n; return stackPtr; },
    malloc: (size: number, _align: number) => { const p = cursor; cursor += size; return p; },
    solve: (retptr: number) => {
      dv.setInt32(retptr, answer > 0 ? 1 : 0, true);  // status @0：answer>0 才成功
      dv.setFloat64(retptr + 8, answer, true); // answer @8 = f64
      if (hasSignature) {
        new TextEncoder().encodeInto('sig123', mem.subarray(retptr + 16, retptr + 16 + 64));
      }
    },
    readPtr: (ptr: number, len: number) => mem.subarray(ptr, ptr + len),
    memoryView: () => mem,
  };
}

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

describe('PowSolver', () => {
  it('solves via wasm and returns base64 header (f64 answer, status=1)', async () => {
    const challenge = { algorithm: 'DeepSeekHashV1', challenge: 'abc', difficulty: 3, target_path: '/api/v0/chat/completion', salt: 's1', expire_at: 1700000000, signature: 'sig123' };
    const solver = new PowSolver({
      fetchJson: async (path, _h, body) => {
        expect(path).toBe('/chat/create_pow_challenge');
        expect((body as any).target_path).toBe('/api/v0/chat/completion');
        return challenge;
      },
      fetchBytes: async (url) => { expect(url).toBe(WASM_URL); return new Uint8Array([0]); },
      instantiate: async () => fakeWasm(42),
      wasmUrl: WASM_URL,
    });
    const header = await solver.solve(challenge, { token: 't', requestId: 'r1' });
    const decoded = JSON.parse(atob(header));
    expect(decoded).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'abc', salt: 's1', answer: 42, target_path: '/api/v0/chat/completion', signature: 'sig123' });
  });

  it('getChallenge extracts nested challenge payload from data.biz_data.challenge', async () => {
    const solver = new PowSolver({
      fetchJson: async () => ({ data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'xyz', difficulty: 5, target_path: '/api/v0/chat/completion', salt: 's2', expire_at: 1700000001, signature: 'sig' } } } }),
      fetchBytes: async () => new Uint8Array(),
      instantiate: async () => fakeWasm(1),
      wasmUrl: WASM_URL,
    });
    const c = await solver.getChallenge({ token: 't', requestId: 'r' }, '/api/v0/chat/completion');
    expect(c).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'xyz', difficulty: 5, salt: 's2' });
  });

  it('propagates PowFailedError on solve failure (status=0)', async () => {
    const solver = new PowSolver({
      fetchJson: async () => ({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }),
      fetchBytes: async () => new Uint8Array(),
      instantiate: async () => fakeWasm(0, false),   // status=0 → 内部返回 0 = 无解
      wasmUrl: 'u',
    });
    await expect(solver.solve({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }, { token: 't', requestId: 'r' })).rejects.toThrow(PowFailedError);
  });

  it('propagates PowFailedError on wasm broken', async () => {
    const solver = new PowSolver({
      fetchJson: async () => ({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }),
      fetchBytes: async () => new Uint8Array(),
      instantiate: async () => { throw new Error('wasm broken'); },
      wasmUrl: 'u',
    });
    await expect(solver.solve({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }, { token: 't', requestId: 'r' })).rejects.toThrow(PowFailedError);
  });
});

// 2026-09-11（fix/review-r1）：wasm 缓存层一次瞬时失败必须能自愈，且一次 solve 只下载一次。
describe('PowSolver review-r1 fixes', () => {
  const challenge = { algorithm: 'DeepSeekHashV1', challenge: 'abc', difficulty: 3, target_path: '/api/v0/chat/completion', salt: 's1', expire_at: 1700000000, signature: 'sig123' };

  it('instantiate 首次失败后不污染缓存，第二次调用可成功', async () => {
    let calls = 0;
    const solver = new PowSolver({
      fetchJson: async () => challenge,
      fetchBytes: async () => new Uint8Array([0]),
      instantiate: async () => { calls++; if (calls === 1) throw new Error('cdn hiccup'); return fakeWasm(42); },
      wasmUrl: WASM_URL,
    });
    await expect(solver.solve(challenge, { token: 't', requestId: 'r1' })).rejects.toThrow(PowFailedError);
    const header = await solver.solve(challenge, { token: 't', requestId: 'r2' });
    expect(JSON.parse(atob(header)).answer).toBe(42);
    expect(calls).toBe(2);
  });

  it('缓存命中时不再重复下载 wasm', async () => {
    let downloads = 0;
    const solver = new PowSolver({
      fetchJson: async () => challenge,
      fetchBytes: async () => { downloads++; return new Uint8Array([0]); },
      instantiate: async () => fakeWasm(42),
      wasmUrl: WASM_URL,
    });
    await solver.solve(challenge, { token: 't', requestId: 'r1' });
    await solver.solve(challenge, { token: 't', requestId: 'r2' });
    expect(downloads).toBe(1);
  });
});
