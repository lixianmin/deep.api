import type { ProviderContext } from '../adapter';

export interface Challenge {
  algorithm: string;
  challenge: string;
  difficulty: number;
  target_path: string;
  salt: string;
  expire_at: number;
  signature?: string;
}
export interface WasmInstance {
  addToStack(n: number): number;
  malloc(size: number, align: number): number;
  solve(retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number): void;
  readPtr(ptr: number, len: number): Uint8Array;
  memoryView(): Uint8Array;
}
export class PowFailedError extends Error {
  constructor(m: string) { super(m); this.name = 'PowFailedError'; }
}

// retptr 结果布局（对照 RezaParsian/DeepseekPowsolver 真实 wasm 实测）：
// status(i32)@0 + answer(f64)@8； status=1 成功、0 失败
//
export async function instantiateDeepSeekWasm(bytes: Uint8Array): Promise<WasmInstance> {
  const result = await WebAssembly.instantiate(bytes, { wbg: {} }) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const { instance } = result;
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory | undefined;
  if (!memory) throw new PowFailedError('wasm: memory export missing');
  const addToStack = exports.__wbindgen_add_to_stack_pointer as ((n: number) => number) | undefined;
  const malloc = exports.__wbindgen_export_0 as ((size: number, align: number) => number) | undefined;
  const solve = exports.wasm_solve as ((r: number, c: number, cl: number, p: number, pl: number, d: number) => void) | undefined;
  if (!addToStack || !malloc || !solve) throw new PowFailedError('wasm: required exports missing');
  return {
    addToStack: (n) => addToStack(n),
    malloc: (size, align) => malloc(size, align),
    solve: (r, c, cl, p, pl, d) => solve(r, c, cl, p, pl, d),
    readPtr: (ptr, len) => new Uint8Array(memory.buffer, ptr, len),
    memoryView: () => new Uint8Array(memory.buffer),
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
    // 实测响应：{code:0, data:{biz_code:0, biz_data:{challenge:{...}}}}，challenge 在 data.biz_data.challenge
    const d = r as { data?: { biz_data?: { challenge?: Challenge } | null; challenge?: Challenge } };
    const data = d?.data?.biz_data?.challenge ?? d?.data?.challenge;
    if (!data) throw new PowFailedError('challenge payload missing');
    return data;
  }

  async solve(challenge: Challenge, ctx: ProviderContext): Promise<string> {
    try {
      const wasm = this.wasmCache ??= this.deps.instantiate(await this.deps.fetchBytes(this.deps.wasmUrl));
      const inst = await wasm;
      // 对照 RezaParsian/DeepseekPowsolver（真实 wasm 实测）：
      // 1) malloc 是 __wbindgen_export_0(size, align)，2 参数（align=1）
      // 2) answer 是 f64（栈偏移 +8），status=1 成功、0 失败
      // 3) malloc 可能 realloc 内存 → 每次操作后重新获取 buffer 视图
      const passString = (str: string) => {
        const b = new TextEncoder().encode(str);
        // malloc 可能触发内存增长，必须 malloc 后再取 memoryView 写入
        const ptr = inst.malloc(b.length, 1) >>> 0;
        inst.memoryView().set(b, ptr);
        return { ptr, len: b.length };
      };
      const prefix = `${challenge.salt}_${challenge.expire_at}_`;
      const stackPtr = inst.addToStack(-16);
      try {
        const c = passString(challenge.challenge);
        const p = passString(prefix);
        inst.solve(stackPtr, c.ptr, c.len, p.ptr, p.len, challenge.difficulty);
        const dv = new DataView(inst.memoryView().buffer);
        const status = dv.getInt32(stackPtr + 0, true);
        if (status !== 1) throw new PowFailedError(`wasm solve status=${status}`);
        const answer = dv.getFloat64(stackPtr + 8, true);
        const json = JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer, signature: challenge.signature ?? '', target_path: challenge.target_path });
        return btoa(json);
      } finally {
        inst.addToStack(16);
      }
    } catch (e) {
      if (e instanceof PowFailedError) throw e;
      throw new PowFailedError(`pow solve failed: ${(e as Error).message}`);
    }
  }
}
