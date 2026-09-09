import type { LogEntry } from '../../background/log';
import type { ThreadRow } from '../../background/session-mapper';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; }
let singleton: { api: PanelApi; port: any } | null = null;

export interface PanelApi {
  listLogs(): Promise<LogEntry[]>;
  listThreads(): Promise<ThreadRow[]>;
}

export function getPanelApi(): PanelApi {
  if (singleton) return singleton.api;
  const port = chrome.runtime.connect({ name: 'deepapi-panel' });
  const pending = new Map<number, Pending>();
  let seq = 0;
  port.onMessage.addListener((env: any) => {
    if (env?.kind !== 'state') return;
    // 注意：panel 通道用 kind 字段不带 id；通过 payload 类型区分
    // 但 server 可能并发推多个 state；这里假设 server 每次只回应一个 in-flight 请求
    // 简化：用 FIFO 队列匹配
    const first = pending.values().next().value;
    if (!first) return;
    pending.delete(0);
    if (env.payload?.log) first.resolve(env.payload.log);
    else if (env.payload?.threads) first.resolve(env.payload.threads);
    else first.reject(new Error('unknown state payload'));
  });
  const send = (kind: string, resolveKey: 'log' | 'threads'): Promise<any> =>
    new Promise((res, rej) => {
      pending.set(0, { resolve: res, reject: rej });   // 简化：单 in-flight
      port.postMessage({ kind });
    });
  const api: PanelApi = {
    listLogs: () => send('panel.listLogs', 'log'),
    listThreads: () => send('panel.listThreads', 'threads'),
  };
  singleton = { api, port };
  return api;
}
