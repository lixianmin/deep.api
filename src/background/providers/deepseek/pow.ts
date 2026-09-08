import type { ProviderContext } from '../adapter';

export interface Challenge {
  algorithm: string;
  challenge: string;
  difficulty: number;
  target_path: string;
  salt: string;
  expire_at: number;
}
export interface WasmInstance {
  addToStack(n: number): number;
  alloc(len: number): number;
  solve(retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number): void;
  readPtr(ptr: number, len: number): Uint8Array;
}
export class PowFailedError extends Error {
  constructor(m: string) { super(m); this.name = 'PowFailedError'; }
}

// retptr 结果布局（单点定义，便于 Task 2 spike 用真实 wasm 校准）：
// wasm-bindgen 返回结构约定：status(i32)@0 + answer(i64, 8 字节对齐)@8 + signature(64B)@16
// 注：尚未经真实 wasm 实测；Task 2 spike 若显示偏移不同，只改这里并同步 fake 测试。
const POW_STATUS_OFF = 0;
const POW_STATUS_LEN = 4;
const POW_ANSWER_OFF = 8;
const POW_ANSWER_LEN = 8;
const POW_SIGN_OFF = 16;
const POW_SIGN_LEN = 64;

export async function instantiateDeepSeekWasm(bytes: Uint8Array): Promise<WasmInstance> {
  const result = await WebAssembly.instantiate(bytes, {}) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const { instance } = result;
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory | undefined;
  if (!memory) throw new PowFailedError('wasm: memory export missing');
  const addToStack = exports.__wbindgen_add_to_stack_pointer as ((n: number) => number) | undefined;
  const alloc = (exports.__wbindgen_malloc as ((l: number) => number) | undefined)
    ?? Object.entries(exports).find(([k, v]) => k.startsWith('__wbindgen_export_') && typeof v === 'function')?.[1] as ((l: number) => number) | undefined;
  const solve = exports.wasm_solve as ((r: number, c: number, cl: number, p: number, pl: number, d: number) => void) | undefined;
  if (!addToStack || !alloc || !solve) throw new PowFailedError('wasm: required exports missing');
  return {
    addToStack: (n) => addToStack(n),
    alloc: (l) => alloc(l),
    solve: (r, c, cl, p, pl, d) => solve(r, c, cl, p, pl, d),
    readPtr: (ptr, len) => new Uint8Array(memory.buffer, ptr, len),
  };
}

export class PowSolver {
  private wasmCache: Promise<WasmInstance> | null = null;
  constructor(private deps: {
    fetchJson: (path: string, headers: Record<string, string>, body: unknown) => Promise<unknown>;
    fetchBytes: (url: string) => Promise<Uint8Array>;
    instantiate: (b: Uint8Array) => Promise<WasmInstance>;
    wasmUrl: string;
  }) {}

  async getChallenge(ctx: ProviderContext, targetPath: string): Promise<Challenge> {
    const r = await this.deps.fetchJson('/chat/create_pow_challenge', { Authorization: `Bearer ${ctx.token}` }, { target_path: targetPath });
    const data = (r as { data?: { challenge?: Challenge } }).data?.challenge;
    if (!data) throw new PowFailedError('challenge payload missing');
    return data;
  }

  async solve(challenge: Challenge, ctx: ProviderContext): Promise<string> {
    try {
      const wasm = this.wasmCache ??= this.deps.instantiate(await this.deps.fetchBytes(this.deps.wasmUrl));
      const inst = await wasm;
      const readI32 = (ptr: number) => {
        const v = inst.readPtr(ptr, 4);
        return new DataView(v.buffer, v.byteOffset, v.byteLength).getInt32(0, true);
      };
      const readI64 = (ptr: number) => {
        const v = inst.readPtr(ptr, 8);
        return new DataView(v.buffer, v.byteOffset, v.byteLength).getBigInt64(0, true);
      };
      const prefix = `${challenge.salt}_${challenge.expire_at}_`;
      const enc = new TextEncoder();
      const cBytes = enc.encode(challenge.challenge);
      const pBytes = enc.encode(prefix);
      const retptr = inst.addToStack(-16);
      const cPtr = inst.alloc(cBytes.length);
      const pPtr = inst.alloc(pBytes.length);
      const write = (ptr: number, bytes: Uint8Array) => {
        const view = inst.readPtr(ptr, bytes.length);
        new Uint8Array(view.buffer, view.byteOffset, bytes.length).set(bytes);
      };
      write(cPtr, cBytes);
      write(pPtr, pBytes);
      inst.solve(retptr, cPtr, cBytes.length, pPtr, pBytes.length, challenge.difficulty);
      const status = readI32(retptr + POW_STATUS_OFF);
      if (status !== 0) throw new PowFailedError(`wasm solve status=${status}`);
      const answer = readI64(retptr + POW_ANSWER_OFF);
      const signature = new TextDecoder().decode(inst.readPtr(retptr + POW_SIGN_OFF, POW_SIGN_LEN)).replace(/\0+$/, '');
      const json = JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer: Number(answer), signature, target_path: challenge.target_path });
      return btoa(json);
    } catch (e) {
      if (e instanceof PowFailedError) throw e;
      throw new PowFailedError(`pow solve failed: ${(e as Error).message}`);
    }
  }
}
