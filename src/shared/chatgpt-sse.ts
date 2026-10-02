/**
 * ChatGPT provider SSE 帧拆解与解析（纯函数，地基模块）。
 *
 * 协议来源：docs/superpowers/specs/2026-10-01-chatgpt-sse-protocol.md
 * ——真实抓帧（18 帧 / span 6783ms / INCREMENTAL），不是猜测。
 *
 * 设计要点（被下游 Task 2 依赖）：
 * 1. data 行冒号后**剥掉且仅剥掉一个**前导空格。SSE 规范允许 data: 后跟可选单空格，
 *    留两个会破坏后续 JSON.parse；多剥会破坏裸字符串帧（如 `data: [DONE]` 后面跟
 *    不寻常空格时）。
 * 2. 帧可能被网络 chunk 切断。splitFrames 必须把不完整的尾巴留在 rest 字段，
 *    下次调用时再拼。这是本任务最容易写错的地方。
 * 3. data 保留**原始字符串**，不解析 JSON——因为 `data: "v1"`（JSON 字符串）与
 *    `data: [DONE]`（根本不是 JSON）都在帧序列中出现。JSON 解析交给下游 Task 2。
 * 4. 帧之间以**空行**（\n\n）分隔。容许 \r\n 行尾（fetch/ReadableStream 在不同平台下
 *    可能给 \n 或 \r\n）。
 */

export interface SseFrame {
  /** SSE `event:` 字段；未给出则为 null。 */
  event: string | null;
  /** SSE `data:` 字段的原始字符串（可能为 JSON、JSON 字符串或裸哨兵如 [DONE]）。 */
  data: string;
}

/**
 * 按 SSE 空行切帧。返回完整帧与未成帧的残留（rest）。
 *
 * 调用方应维护一个跨调用的 buffer，每次把新到的网络 chunk 拼到 buffer 末尾再调用本函数，
 * 把返回的 rest 留到下次。这就是协议 doc 实测的 INCREMENTAL 流式行为。
 *
 * 容错：
 * - \r\n 与 \n 等价（normalize 后再切）。
 * - 连续 \n\n（多空帧边界）合并过滤。
 * - 末尾 \n 缺一半（stream 关闭但 stream-end 标记未到）整体进 rest。
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  // 行尾归一化：先把 \r\n 整体替换为 \n（只影响换行，不动 data 里的 \n——data 里 JSON 转义是 \\n 字面字符，与传输层的 \r\n 无关）
  const normalized = buffer.replace(/\r\n/g, '\n');
  // 取最后一个 \n\n 作为「完整帧边界」：它之前全是完整帧，它之后是不完整尾。
  // 这是跨 chunk 拆帧的关键：lastIndexOf 而非 split，保证把残尾留 rest 等下次拼接。
  const lastDouble = normalized.lastIndexOf('\n\n');
  if (lastDouble === -1) {
    return { frames: [], rest: normalized };
  }
  const complete = normalized.slice(0, lastDouble);
  const rest = normalized.slice(lastDouble + 2);
  // 切 \n\n 后过滤空段（连续空行 / 起始空行产生的 ""）。
  const frames = complete.split('\n\n').filter(f => f.length > 0);
  return { frames, rest };
}

/**
 * 解析单帧；不成帧返回 null。
 *
 * 判定：
 * - 空字符串、纯空行、只有 event 无 data → null（与既有 DeepSeek 解析器 filter 行为一致）。
 * - 至少一条 data 行才产出帧；多条 data 行按 SSE 规范用 \n 拼接。
 *
 * 容错：
 * - data/event 行冒号后**剥一个**前导空格（不剥全部）。
 * - `: ` 开头的注释行忽略；未知字段（id: / retry:）忽略。
 */
export function parseFrame(raw: string): SseFrame | null {
  if (raw.length === 0) return null;
  let event: string | null = null;
  const dataParts: string[] = [];
  for (const line of raw.split('\n')) {
    // 注释行（SSE: 以 : 开头的整行）——忽略
    if (line.startsWith(':')) continue;
    // event: 行——剥一个前导空格；多行时后者覆盖前者（实测 ChatGPT 不会多 event 行；这是规范默认行为）
    if (line.startsWith('event:')) {
      event = stripOneLeadingSpace(line.slice('event:'.length));
      continue;
    }
    // data: 行——剥一个前导空格；按规范多行用 \n 拼接
    if (line.startsWith('data:')) {
      dataParts.push(stripOneLeadingSpace(line.slice('data:'.length)));
      continue;
    }
    // 其他字段（id: / retry:）——当前 provider 不消费，忽略
  }
  // 空 data → 不成帧（与既有 DeepSeek `filter(e.data !== '')` 一致）
  if (dataParts.length === 0) return null;
  const data = dataParts.join('\n');
  if (data === '') return null;
  return { event, data };
}

/** 剥且仅剥一个前导空格（与 SSE 规范的 "optional single space" 对齐）。 */
function stripOneLeadingSpace(s: string): string {
  return s.startsWith(' ') ? s.slice(1) : s;
}
