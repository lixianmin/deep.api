import type { LogEntry } from '../../background/log';
import type { ThreadRow } from '../../background/session-mapper';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** 同一 slot 的在飞请求复用同一个 promise（log/sse 两个常驻 tab 会轮询同一个 listLogs）。 */
  promise: Promise<unknown>;
}
let singleton: { api: PanelApi; port: any } | null = null;

/** 2026-09-11（fix/review-r1）：panel 请求超时。旧实现没有超时——一旦响应被别的在飞请求吃掉
 *  （单槽位覆盖）或 port 断线，promise 永久挂起，对应 tab 永久空白。 */
export const PANEL_REQUEST_TIMEOUT_MS = 15_000;

export interface PanelApi {
  listLogs(): Promise<LogEntry[]>;
  listThreads(): Promise<ThreadRow[]>;
}

/**
 * 2026-09-11（fix/review-r1）：旧实现用「pending Map key 恒为 0」的单 in-flight 槽位，且只按
 * FIFO 取第一个 pending 结算。debug 页三个 tab 常驻、各自 30s 轮询 + 手点刷新 + SW 主动广播
 * （payload 含 providers+log）都会落进同一个窗口：
 *   1) 响应张冠李戴（listThreads 收到 log 数组 → routing tab 直接 TypeError）；
 *   2) 被覆盖的请求永久挂起；
 *   3) port 断开（扩展 reload / SW 回收）后单例永不复原 → 三个 tab 永久空白。
 * 修法：按请求类型各留一个在飞槽位 + 只在 payload 形状匹配时结算 + 超时 + onDisconnect 复位。
 */
export function getPanelApi(): PanelApi {
  if (singleton) return singleton.api;
  const port = chrome.runtime.connect({ name: 'deepapi-panel' });
  const inflight: { logs: Pending | null; threads: Pending | null } = { logs: null, threads: null };

  const settle = (slot: 'logs' | 'threads', fn: (p: Pending) => void): void => {
    const p = inflight[slot];
    if (!p) return;
    inflight[slot] = null;
    if (p.timer !== null) clearTimeout(p.timer);
    fn(p);
  };

  port.onMessage.addListener((env: any) => {
    if (env?.kind !== 'state') return;
    const payload = env.payload;
    if (!payload || typeof payload !== 'object') return;
    // 2026-09-11：SW 的 broadcastPanelState 主动推 {providers, log}——它不是对本次请求的应答
    // （且可能夹带旧日志），一旦当成应答就会张冠李戴。带 providers 的 payload 一律忽略。
    if ('providers' in payload) return;
    // 严格按 payload 形状配对：listLogs 只认 log，listThreads 只认 threads；不匹配直接忽略。
    if (Array.isArray(payload.log)) { settle('logs', (p) => p.resolve(payload.log)); return; }
    if (Array.isArray(payload.threads)) { settle('threads', (p) => p.resolve(payload.threads)); return; }
  });

  port.onDisconnect.addListener(() => {
    // 2026-09-11：port 死后必须结算在飞请求并清空单例，否则后续每次调用都复用死 port，永远失败。
    if (singleton && singleton.port === port) singleton = null;
    const err = new Error('deepapi-panel port disconnected');
    settle('logs', (p) => p.reject(err));
    settle('threads', (p) => p.reject(err));
  });

  const send = <T>(kind: string, slot: 'logs' | 'threads'): Promise<T> => {
    // 2026-09-11（fix/review-r2）：同 slot 已有在飞请求时**复用同一个 promise**，不再 reject 旧的。
    // log 与 sse 两个常驻 tab 各自 30s 轮询同一个 listLogs——旧实现把先到者 settle 成
    // 「superseded by a newer request」，先到 tab 渲染红色错误并丢掉一轮数据。
    const existing = inflight[slot];
    if (existing) return existing.promise as Promise<T>;
    let resolveFn!: (v: unknown) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => { resolveFn = res as (v: unknown) => void; rejectFn = rej as (e: Error) => void; });
    const p: Pending = {
      resolve: (v) => resolveFn(v),
      reject: (e) => rejectFn(e),
      timer: null,
      promise,
    };
    p.timer = setTimeout(() => {
      if (inflight[slot] === p) inflight[slot] = null;
      rejectFn(new Error(`panel request timeout after ${PANEL_REQUEST_TIMEOUT_MS}ms: ${kind}`));
    }, PANEL_REQUEST_TIMEOUT_MS);
    inflight[slot] = p;
    port.postMessage({ kind });
    return promise as Promise<T>;
  };

  const api: PanelApi = {
    listLogs: () => send<LogEntry[]>('panel.listLogs', 'logs'),
    listThreads: () => send<ThreadRow[]>('panel.listThreads', 'threads'),
  };
  singleton = { api, port };
  return api;
}
