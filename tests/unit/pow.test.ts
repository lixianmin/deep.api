import { describe, it, expect } from 'vitest';
import { PowSolver, PowFailedError, type WasmInstance } from '../../src/background/providers/deepseek/pow';

// 窄接口 fake：模拟 wasm 按 wasm-bindgen 返回约定写入 retptr 布局：
// status(i32)@0 + answer(i64, 8 字节对齐)@8 + signature(64B)@16，与 pow.ts 常量一致
function fakeWasm(answer: number, signature: string): WasmInstance {
  const mem = new Uint8Array(4096);
  const dv = new DataView(mem.buffer);
  let cursor = 256;
  let stackPtr = 2048;
  return {
    addToStack: (n: number) => { stackPtr += n; return stackPtr; },
    alloc: (len: number) => { const p = cursor; cursor += len; return p; },
    solve: (retptr: number) => {
      dv.setInt32(retptr, 0, true);            // status @0
      dv.setBigInt64(retptr + 8, BigInt(answer), true);  // answer @8
      new TextEncoder().encodeInto(signature, mem.subarray(retptr + 16, retptr + 16 + 64)); // signature @16
    },
    readPtr: (ptr: number, len: number) => mem.subarray(ptr, ptr + len),
  };
}

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

describe('PowSolver', () => {
  it('fetches challenge and solves via wasm, returning base64 header', async () => {
    const challenge = { algorithm: 'DeepSeekHashV1', challenge: 'abc', difficulty: 3, target_path: '/api/v0/chat/completion', salt: 's1', expire_at: 1700000000 };
    const solver = new PowSolver({
      fetchJson: async (path, _h, body) => {
        expect(path).toBe('/api/v0/chat/create_pow_challenge');
        expect((body as any).target_path).toBe('/api/v0/chat/completion');
        return challenge;
      },
      fetchBytes: async (url) => { expect(url).toBe(WASM_URL); return new Uint8Array([0]); },
      instantiate: async () => fakeWasm(42, 'sig123'),
      wasmUrl: WASM_URL,
    });
    const header = await solver.solve(challenge, { token: 't', requestId: 'r1' });
    const decoded = JSON.parse(atob(header));
    expect(decoded).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'abc', salt: 's1', answer: 42, target_path: '/api/v0/chat/completion', signature: 'sig123' });
  });

  it('getChallenge extracts nested challenge payload', async () => {
    const solver = new PowSolver({
      fetchJson: async () => ({ data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'xyz', difficulty: 5, target_path: '/api/v0/chat/completion', salt: 's2', expire_at: 1700000001 } } }),
      fetchBytes: async () => new Uint8Array(),
      instantiate: async () => fakeWasm(1, ''),
      wasmUrl: WASM_URL,
    });
    const c = await solver.getChallenge({ token: 't', requestId: 'r' }, '/api/v0/chat/completion');
    expect(c).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'xyz', difficulty: 5, salt: 's2' });
  });

  it('propagates PowFailedError on solve failure', async () => {
    const solver = new PowSolver({
      fetchJson: async () => ({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }),
      fetchBytes: async () => new Uint8Array(),
      instantiate: async () => { throw new Error('wasm broken'); },
      wasmUrl: 'u',
    });
    await expect(solver.solve({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }, { token: 't', requestId: 'r' })).rejects.toThrow(PowFailedError);
  });
});
