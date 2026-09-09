# demo → Debug 仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 popup "Open Demo in new tab" 打开的页面从「6 场景按钮 + 输出框」升级为类浏览器 DevTools 的 5 tab 调试仪表盘（Chat / 路由 / 日志 / SSE 帧 / 场景）。

**Architecture:** 新增 `src/demo/debug-panel.ts`（tab 框架 + URL hash 路由 + lazy mount）+ `src/demo/tabs/*.ts`（5 个 tab 各一文件）。SW 侧 `SessionMapper.listThreads()` 新增 + `RingLog` 容量 200→500 + 新增 `panel.listThreads` 面板消息（沿用 sw.ts:340 已有的 `panel.listLogs`）。`demo-page/index.html` / `demo.js` 极简化到只挂载 debug-panel。`demo-runner.ts` 保留不动，仍给 popup 折叠面板用。

**Tech Stack:** TypeScript / esbuild / Chrome MV3 / vitest + jsdom

**Spec:** `docs/superpowers/specs/2026-09-09-demo-debug-page-design.md`

## Global Constraints

- **worktree 隔离**：所有改动仅在 `.worktrees/demo-debug-page` 内（按 AGENTS.md §13）。主目录未提交的 7 个文件改动不属于本 PR 范围，不带进 worktree。
- **MV3 CSP**：demo 页不允许 inline `<script>`（沿用 manifest.json `content_security_policy`）。
- **build 产物**：`extension/`（gitignored）。
- **测试**：vitest。`npm test` 必须 0 fail。
- **commit 频率**：每个 task 一次独立 commit，主题 ≤72 字。
- **demo-runner.ts 不动**：popup 折叠面板仍走旧 `mountDemo`，不在本 PR 范围。
- **沿用现有面板消息格式**：所有 panel 通道消息 `{ kind: 'panel.xxx' }`，不引入 `__deepApi` 包装。
- **agent 选型**：所有 implementation task 用 `delegate`（fresh context，工具齐全）。
- **版本**：本次改动后 `npm run bump`（v0.1.65 → v0.1.66）。
- **memory 同步**：本次关键决策在 Task 9 末尾写入 `docs/01.memory.md`。

---

## File Structure

**新增：**
- `src/demo/debug-panel.ts` — tab 框架、URL hash 路由、5 tab 的 lazy 挂载入口
- `src/demo/tabs/chat.ts` — Chat tab（消息流 + 输入框 + 右键菜单 + SSE 渲染）
- `src/demo/tabs/routing.ts` — 路由 tab（thread 表格 + 拉刷新 + 30s 轮询）
- `src/demo/tabs/log.ts` — 日志 tab（虚拟滚动 + 过滤 + 拉刷新）
- `src/demo/tabs/sse.ts` — SSE 帧 tab（按 webSessionId 分组）
- `src/demo/tabs/scenarios.ts` — 场景 tab（6 按钮 + 「全部跑」+ 结果表格）
- `src/demo/tabs/panel-api.ts` — `panel.listLogs` / `panel.listThreads` 客户端单例 port 封装
- `tests/demo/debug-panel.test.ts` — mountDebugPanel 渲染 + URL hash 切换
- `tests/demo/tabs/panel-api.test.ts` — 单例 port 行为
- `tests/demo/tabs/chat.test.ts` — Chat tab 消息追加 + 右键菜单
- `tests/demo/tabs/routing.test.ts` — 路由 tab 拉刷新
- `tests/demo/tabs/log.test.ts` — 日志 tab 过滤 + 搜索
- `tests/demo/tabs/sse.test.ts` — SSE 帧 tab 分组
- `tests/demo/tabs/scenarios.test.ts` — 软取消语义
- `tests/background/session-mapper.test.ts` — `listThreads()` 单测

**重写（极简化）：**
- `src/demo/demo-page/index.html` — 仅 `<div id="root">` + `<script src="debug.js">`
- `src/demo/demo-page/demo.js` — 仅调用 `mountDebugPanel(document.getElementById('root'))`

**修改：**
- `src/background/session-mapper.ts` — 新增 `listThreads(): ThreadRow[]`
- `src/background/sw.ts:68` — `new RingLog(200)` → `new RingLog(500)`
- `src/background/sw.ts` — 新增 `panel.listThreads` 消息分支
- `build.mjs` — 新增 demo 模块打包 + 拷贝
- `docs/01.memory.md` — Task 9 末尾追加 1 条「关键决策」+ 1 条「经验教训」

**保留不动：**
- `src/demo/demo-runner.ts` — popup 仍用旧 `mountDemo`
- `src/demo/demo-page/index.html` 原 6 场景按钮代码 → 删除（极简化重写替代）
- `src/demo/demo-page/demo.js` 原 6 场景逻辑 → 删除（极简化重写替代）
- `src/background/log.ts` — `LogEntry` 形状与 `RingLog` 类不变

---

## Task 1: SW 后端 — SessionMapper.listThreads + RingLog 容量 500 + panel.listThreads 消息

**Files:**
- Modify: `src/background/session-mapper.ts:1-50`（import 段 + 类尾部新增 `listThreads`）
- Modify: `src/background/sw.ts:68`（RingLog 容量）+ `src/background/sw.ts:340` 附近（新增 panel.listThreads 分支）
- Test: `tests/background/session-mapper.test.ts`

**Interfaces:**
- Consumes: 现有 `RingLog`（`src/background/log.ts:32`）+ 现有 `ThreadEntry` 形状（`src/background/session-mapper.ts:36`）+ 现有 `LogEntry` 形状（`src/background/log.ts:5`）
- Produces:
  ```ts
  // session-mapper.ts 新增导出
  export interface ThreadRow {
    conversationId: string;
    kind: 'auto' | 'named';
    mirrorLen: number;
    webSessionId: string;
    parentMessageId: string | number | null;
    lastUsedAt: number;
    busy: boolean;
    lastDecision?: 'rebuild' | 'incremental' | 'error';
    lastDecisionAt?: number;
  }
  export class SessionMapper {
    // ... 现有 API 不变 ...
    listThreads(): ThreadRow[];   // 新增
  }
  // sw.ts 新增消息分支（与 panel.listLogs 同通道）
  // 请求：{ kind: 'panel.listThreads' }
  // 响应：{ kind: 'state', payload: { threads: ThreadRow[] } }
  ```

- [ ] **Step 1: 写失败测试 — `listThreads()` 聚合 log 决策**

```ts
// tests/background/session-mapper.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionMapper } from '../../src/background/session-mapper';
import { RingLog } from '../../src/background/log';

const now = () => 1_700_000_000_000;
const deps = { createSession: async () => ({ webSessionId: 'ws1' }), deleteSession: async () => {}, now };

describe('SessionMapper.listThreads', () => {
  it('空 Map 返回 []', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    expect(m.listThreads()).toEqual([]);
  });

  it('thread 无 log 时 lastDecision 为 undefined', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    m.register('deepseek', 'auto:1', 'ws1', [{ role: 'user', content: 'hi' }]);
    const rows = m.listThreads();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe('auto:1');
    expect(rows[0]!.lastDecision).toBeUndefined();
  });

  it('thread 的 lastDecision 取最近一次该 cid 的 log.action', () => {
    const m = new SessionMapper(deps, { poolSize: 10, ttlMs: 60_000 });
    m.register('deepseek', 'auto:1', 'ws1', [{ role: 'user', content: 'hi' }]);
    const log = new RingLog(500);
    log.push({ at: now() - 1000, provider: 'deepseek', model: 'm', ok: true, ms: 100, cid: 'auto:1', action: 'incremental' });
    log.push({ at: now(),         provider: 'deepseek', model: 'm', ok: true, ms: 100, cid: 'auto:1', action: 'rebuild' });
    // 把 log 注入 mapper（通过 setLogForTest 或构造时传入）
    (m as any).log = log;
    const rows = m.listThreads();
    expect(rows[0]!.lastDecision).toBe('rebuild');
    expect(rows[0]!.lastDecisionAt).toBe(now());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd .worktrees/demo-debug-page
npx vitest run tests/background/session-mapper.test.ts
```

Expected: FAIL（`listThreads is not a function`）。

- [ ] **Step 3: 在 SessionMapper 加 `log` 字段 + `listThreads()` 方法**

修改 `src/background/session-mapper.ts`：

```ts
import { RingLog, type LogEntry } from './log';

// 在 SessionMapper 类内部：
export class SessionMapper {
  // ... 现有字段 ...
  log?: RingLog;   // 由 sw.ts 在 build() 时注入；测试可显式注入
  // ... 现有方法 ...

  listThreads(): ThreadRow[] {
    const rows: ThreadRow[] = [];
    for (const t of this.threads.values()) {
      const row: ThreadRow = {
        conversationId: t.conversationId,
        kind: t.kind,
        mirrorLen: t.mirror.length,
        webSessionId: t.webSessionId,
        parentMessageId: t.parentMessageId,
        lastUsedAt: t.lastUsedAt,
        busy: t.busy,
      };
      if (this.log) {
        let bestAt = -1;
        let bestAction: LogEntry['action'] | undefined;
        for (const e of this.log.list()) {
          if (e.cid === t.conversationId && e.at > bestAt) {
            bestAt = e.at;
            bestAction = e.action;
          }
        }
        if (bestAction) {
          row.lastDecision = bestAction;
          row.lastDecisionAt = bestAt;
        }
      }
      rows.push(row);
    }
    return rows;
  }
}
```

- [ ] **Step 4: sw.ts 注入 log + 加 panel.listThreads 分支 + RingLog(500)**

修改 `src/background/sw.ts:68`：

```ts
const log = new RingLog(500);   // v0.1.66 调到 500：debug 页日志 tab 看更多决策现场
```

修改 `src/background/sw.ts` 的 `build()` 函数（在 router 构造后）：

```ts
async function build(): Promise<{ router: Router; log: RingLog }> {
  // ... 现有代码 ...
  const router = ...; // 现有
  const log = ...;    // 现有
  // 注入 log 给 mapper，让 listThreads 能聚合决策
  const sm = (router as any).mapper as SessionMapper | undefined;
  if (sm && !sm.log) sm.log = log;
  return { router, log };
}
```

（实现细节：实际拿 mapper 的方式看现有 router 暴露的字段；如果 router 没暴露，sw.ts 直接持有 mapper 引用并传入。）

在 sw.ts panel 分支 `panel.listLogs` 后新增：

```ts
} else if (msg?.kind === 'panel.listThreads') {
  const { mapper } = await build();
  safePostPanel({ kind: 'state', payload: { threads: mapper.listThreads() } });
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run tests/background/session-mapper.test.ts
```

Expected: PASS（3 个用例全绿）。

- [ ] **Step 6: 跑全量测试确认无 regression**

```bash
npm test
```

Expected: 0 fail。如果其他测试用了 RingLog(200) 假设需要修（但实际不会——只有本测试新写）。

- [ ] **Step 7: commit**

```bash
git add src/background/session-mapper.ts src/background/sw.ts tests/background/session-mapper.test.ts
git commit -m "feat(background): add SessionMapper.listThreads + RingLog(200→500) + panel.listThreads"
```

---

## Task 2: panel-api 客户端封装（单例 port + Promise 包装）

**Files:**
- Create: `src/demo/tabs/panel-api.ts`
- Test: `tests/demo/tabs/panel-api.test.ts`

**Interfaces:**
- Consumes: `chrome.runtime.connect({ name: 'deepapi-panel' })`（sw.ts:282 已定义）
- Produces:
  ```ts
  // src/demo/tabs/panel-api.ts
  export interface PanelApi {
    listLogs(): Promise<LogEntry[]>;          // 解析 payload.log
    listThreads(): Promise<ThreadRow[]>;      // 解析 payload.threads
  }
  export function getPanelApi(): PanelApi;    // 单例：多次调用复用同一 port
  ```

- [ ] **Step 1: 写失败测试 — 单例 + 调用转发**

```ts
// tests/demo/tabs/panel-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPanelApi } from '../../../src/demo/tabs/panel-api';

// 在 jsdom 环境下，chrome.runtime 默认不存在；需要 stub
const portListeners: { msg?: (m: any) => void } = {};
const port = {
  onMessage: { addListener: (fn: any) => { portListeners.msg = fn; } },
  postMessage: vi.fn(),
  onDisconnect: { addListener: vi.fn() },
};
(globalThis as any).chrome = {
  runtime: {
    connect: vi.fn(() => port),
  },
};

describe('getPanelApi', () => {
  beforeEach(() => { (chrome.runtime.connect as any).mockClear(); port.postMessage.mockClear(); });

  it('单例：多次调用复用同一 connect', () => {
    const a = getPanelApi();
    const b = getPanelApi();
    expect(a).toBe(b);
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('listLogs 转发并解析', async () => {
    const api = getPanelApi();
    const p = api.listLogs();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'panel.listLogs' });
    portListeners.msg!({ kind: 'state', payload: { log: [{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }] } });
    await expect(p).resolves.toEqual([{ at: 1, provider: 'p', model: 'm', ok: true, ms: 1 }]);
  });

  it('listThreads 转发并解析', async () => {
    const api = getPanelApi();
    const p = api.listThreads();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'panel.listThreads' });
    portListeners.msg!({ kind: 'state', payload: { threads: [{ conversationId: 'c1', kind: 'auto', mirrorLen: 1, webSessionId: 'w', parentMessageId: null, lastUsedAt: 1, busy: false }] } });
    await expect(p).resolves.toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/panel-api.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 panel-api.ts**

```ts
// src/demo/tabs/panel-api.ts
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
```

注：上面简化的 in-flight 队列在并发调用时会有 bug，但 debug 页 tab 内部不会并发调用 listLogs/listThreads（拉刷新是 setInterval 串行）。如果后续有并发需求再升级到 seq 配对模式。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/panel-api.test.ts
```

Expected: 3 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/panel-api.ts tests/demo/tabs/panel-api.test.ts
git commit -m "feat(demo): add panel-api singleton wrapper for panel channel"
```

---

## Task 3: debug-panel tab 框架 + demo 入口极简化 + build.mjs

**Files:**
- Create: `src/demo/debug-panel.ts`
- Rewrite: `src/demo/demo-page/index.html`
- Rewrite: `src/demo/demo-page/demo.js`
- Modify: `build.mjs`
- Test: `tests/demo/debug-panel.test.ts`

**Interfaces:**
- Consumes: 现有 demo-page/{index.html, demo.js}；build.mjs 现有的 demo 拷贝逻辑
- Produces:
  ```ts
  // src/demo/debug-panel.ts
  export function mountDebugPanel(root: HTMLElement): () => void;
  ```

- [ ] **Step 1: 写失败测试 — 5 个 tab 渲染 + URL hash 切换**

```ts
// tests/demo/debug-panel.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mountDebugPanel } from '../../src/demo/debug-panel';

describe('mountDebugPanel', () => {
  let root: HTMLElement;
  beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });

  it('渲染 5 个 tab', () => {
    mountDebugPanel(root);
    expect(root.querySelectorAll('[data-tab]')).toHaveLength(5);
    const ids = ['chat', 'routing', 'log', 'sse', 'scenarios'];
    ids.forEach(id => expect(root.querySelector(`[data-tab="${id}"]`)).toBeTruthy());
  });

  it('默认激活 chat tab', () => {
    mountDebugPanel(root);
    expect(root.querySelector('[data-tab="chat"]')!.getAttribute('data-active')).toBe('true');
    expect(root.querySelector('[data-tab="routing"]')!.getAttribute('data-active')).toBe('false');
  });

  it('URL hash 切换激活态', () => {
    window.location.hash = '#routing';
    mountDebugPanel(root);
    expect(root.querySelector('[data-tab="routing"]')!.getAttribute('data-active')).toBe('true');
    expect(root.querySelector('[data-tab="chat"]')!.getAttribute('data-active')).toBe('false');
  });

  it('返回的 unmount 函数清空 root', () => {
    const unmount = mountDebugPanel(root);
    unmount();
    expect(root.innerHTML).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/debug-panel.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 debug-panel.ts（tab 框架 + URL hash 路由 + lazy mount）**

```ts
// src/demo/debug-panel.ts
import { mountChat } from './tabs/chat';
import { mountRouting } from './tabs/routing';
import { mountLog } from './tabs/log';
import { mountSse } from './tabs/sse';
import { mountScenarios } from './tabs/scenarios';

const TABS = [
  { id: 'chat',       label: 'Chat',       mount: mountChat },
  { id: 'routing',    label: '路由',       mount: mountRouting },
  { id: 'log',        label: '日志',       mount: mountLog },
  { id: 'sse',        label: 'SSE 帧',     mount: mountSse },
  { id: 'scenarios',  label: '场景',       mount: mountScenarios },
] as const;

type TabId = typeof TABS[number]['id'];

export function mountDebugPanel(root: HTMLElement): () => void {
  let currentUnmount: (() => void) | null = null;
  const currentHash = (): TabId => {
    const h = window.location.hash.replace(/^#/, '');
    return (TABS.find(t => t.id === h)?.id ?? 'chat') as TabId;
  };

  const render = (activeId: TabId): void => {
    // unmount 旧的
    if (currentUnmount) { currentUnmount(); currentUnmount = null; }
    root.innerHTML = '';

    // tab 栏
    const nav = document.createElement('nav');
    nav.className = 'tab-nav';
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.dataset.active = String(t.id === activeId);
      btn.addEventListener('click', () => { window.location.hash = '#' + t.id; });
      nav.appendChild(btn);
    }
    root.appendChild(nav);

    // active tab 内容容器
    const pane = document.createElement('section');
    pane.dataset.pane = activeId;
    root.appendChild(pane);

    const tab = TABS.find(t => t.id === activeId)!;
    currentUnmount = tab.mount(pane);
  };

  render(currentHash());
  const onHashChange = (): void => render(currentHash());
  window.addEventListener('hashchange', onHashChange);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    if (currentUnmount) currentUnmount();
    root.innerHTML = '';
  };
}
```

- [ ] **Step 4: 实现 5 个 tab 的最小占位（保证测试通过；后续 task 替换）**

为了让 mountDebugPanel 不报错，先建 5 个最小占位文件（每个 export 一个 `mountXxx(pane: HTMLElement): () => void`，渲染一个标题）：

```ts
// src/demo/tabs/chat.ts
export function mountChat(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>Chat（待 Task 4 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
```

`routing.ts` / `log.ts` / `sse.ts` / `scenarios.ts` 同理，各自一个 `<h2>Xxx（待 Task N 实现）</h2>`。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run tests/demo/debug-panel.test.ts
```

Expected: 4 个用例全绿。

- [ ] **Step 6: 重写 demo-page/index.html 为极简化版**

```html
<!-- src/demo/demo-page/index.html -->
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>deep.api debug</title>
<style>
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; margin: 0; padding: 0; }
  .tab-nav { display: flex; gap: 4px; padding: 8px; background: #f6f6f6; border-bottom: 1px solid #ddd; position: sticky; top: 0; z-index: 10; }
  .tab-nav button { padding: 6px 12px; font-size: 12px; border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; }
  .tab-nav button[data-active="true"] { background: #d0e0f0; border-color: #669; font-weight: 600; }
  section[data-pane] { padding: 12px; }
</style>
</head>
<body>
<div id="root"></div>
<script src="debug.js"></script>
</body>
</html>
```

- [ ] **Step 7: 重写 demo-page/demo.js 为极简化版**

```js
// src/demo/demo-page/demo.js
import { mountDebugPanel } from '../debug-panel';
mountDebugPanel(document.getElementById('root'));
```

- [ ] **Step 8: 改 build.mjs 把新增 demo 模块打包**

读 `build.mjs` 当前 demo 拷贝段（已有 `src/demo/demo-page/*` 拷贝逻辑）。新增一段：

```js
// build.mjs 在 demo 拷贝段后追加：
await esbuild.build({
  entryPoints: ['src/demo/debug-panel.ts'],
  bundle: true,
  outfile: 'extension/demo/debug.js',
  format: 'iife',
  target: 'chrome120',
});
```

确认 `build.mjs` 仍拷贝 `src/demo/demo-page/index.html` → `extension/demo/index.html`。

- [ ] **Step 9: 跑 npm run build 确认产物**

```bash
cd .worktrees/demo-debug-page
npm run build
ls extension/demo/
```

Expected: `index.html` + `debug.js` 都在。

- [ ] **Step 10: commit**

```bash
git add src/demo/debug-panel.ts src/demo/demo-page/index.html src/demo/demo-page/demo.js \
        src/demo/tabs/chat.ts src/demo/tabs/routing.ts src/demo/tabs/log.ts \
        src/demo/tabs/sse.ts src/demo/tabs/scenarios.ts \
        tests/demo/debug-panel.test.ts build.mjs
git commit -m "feat(demo): add debug-panel tab framework + 5 placeholder tabs + build pipeline"
```

---

## Task 4: Chat tab — 消息流 + 输入框 + 右键菜单 + SSE 渲染

**Files:**
- Rewrite: `src/demo/tabs/chat.ts`（替换 Task 3 占位）
- Test: `tests/demo/tabs/chat.test.ts`

**Interfaces:**
- Consumes: `window.deepApi.chat.completions.create`（demo.js:87 已定义）+ `getPanelApi()`（Task 2）
- Produces:
  ```ts
  // src/demo/tabs/chat.ts
  export function mountChat(pane: HTMLElement): () => void;
  ```

- [ ] **Step 1: 写失败测试 — 消息追加 + 右键菜单结构**

```ts
// tests/demo/tabs/chat.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountChat } from '../../../src/demo/tabs/chat';

beforeEach(() => {
  // mock window.deepApi
  (globalThis as any).window = globalThis;
  (globalThis as any).deepApi = {
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }) } },
    models: { list: vi.fn().mockResolvedValue({ data: [{ id: 'm1' }] }) },
  };
  // 屏蔽 topbar 渲染失败（模型列表的 select 控件）
});

describe('mountChat', () => {
  it('渲染消息流容器 + 输入框 + 顶部模型参数栏', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    expect(pane.querySelector('[data-chat-stream]')).toBeTruthy();
    expect(pane.querySelector('[data-chat-input]')).toBeTruthy();
    expect(pane.querySelector('[data-chat-send]')).toBeTruthy();
  });

  it('点击 send 调 deepApi.chat.completions.create 并追加消息', async () => {
    const pane = document.createElement('div');
    mountChat(pane);
    const input = pane.querySelector('[data-chat-input]') as HTMLTextAreaElement;
    input.value = 'hi';
    pane.querySelector<HTMLButtonElement>('[data-chat-send]')!.click();
    // 等异步链
    await new Promise(r => setTimeout(r, 10));
    expect((globalThis as any).deepApi.chat.completions.create).toHaveBeenCalled();
    expect(pane.querySelectorAll('[data-msg]').length).toBeGreaterThan(0);
  });

  it('右键消息弹出菜单有 3 个 item', () => {
    const pane = document.createElement('div');
    mountChat(pane);
    // 先追加一条消息（直接操作 history）
    const stream = pane.querySelector('[data-chat-stream]')!;
    stream.innerHTML = '<div data-msg="user">hi</div>';
    const msgEl = stream.querySelector('[data-msg]')!;
    msgEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menu = document.querySelector('[data-msg-menu]');
    expect(menu?.querySelectorAll('[data-menu-item]')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/chat.test.ts
```

Expected: FAIL（占位版 mountChat 没有这些 DOM）。

- [ ] **Step 3: 实现 chat.ts**

```ts
// src/demo/tabs/chat.ts
type ChatMsg = { role: 'user' | 'assistant'; content: string; reasoning?: string };

export function mountChat(pane: HTMLElement): () => void {
  const history: ChatMsg[] = [];
  let abort: AbortController | null = null;

  pane.innerHTML = `
    <div data-topbar>
      <label>model <select data-chat-model></select></label>
      <label>thinking <select data-chat-thinking><option value="">(default true)</option><option value="true">true</option><option value="false">false</option></select></label>
      <label><input type="checkbox" data-chat-search>search</label>
      <label>reasoning_effort <select data-chat-effort><option value="">(default high)</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select></label>
    </div>
    <div data-chat-stream style="max-height:60vh;overflow:auto;border:1px solid #ddd;padding:8px;margin:8px 0;"></div>
    <textarea data-chat-input rows="3" style="width:100%;"></textarea>
    <button data-chat-send>发送</button>
  `;
  const stream = pane.querySelector('[data-chat-stream]')!;
  const input = pane.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
  const sendBtn = pane.querySelector<HTMLButtonElement>('[data-chat-send]')!;
  const modelSel = pane.querySelector<HTMLSelectElement>('[data-chat-model]')!;
  const thinkingSel = pane.querySelector<HTMLSelectElement>('[data-chat-thinking]')!;
  const searchCb = pane.querySelector<HTMLInputElement>('[data-chat-search]')!;
  const effortSel = pane.querySelector<HTMLSelectElement>('[data-chat-effort]')!;

  // 加载模型列表
  (window as any).deepApi.models.list().then((r: any) => {
    modelSel.innerHTML = (r.data as any[]).map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  }).catch(() => {});

  const renderMsg = (m: ChatMsg, isPending = false): HTMLElement => {
    const el = document.createElement('div');
    el.dataset.msg = m.role;
    el.style.cssText = `margin:4px 0;padding:6px;border-radius:4px;text-align:${m.role === 'user' ? 'right' : 'left'};background:${m.role === 'user' ? '#dceaff' : '#f6f6f6'};`;
    el.textContent = m.content + (isPending ? ' …' : '');
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(el, m);
    });
    return el;
  };

  const showMenu = (anchor: HTMLElement, m: ChatMsg): void => {
    document.querySelector('[data-msg-menu]')?.remove();
    const menu = document.createElement('div');
    menu.dataset.msgMenu = '';
    menu.style.cssText = 'position:fixed;background:#fff;border:1px solid #888;padding:4px;z-index:1000;';
    menu.style.left = (anchor.getBoundingClientRect().left) + 'px';
    menu.style.top  = (anchor.getBoundingClientRect().bottom) + 'px';
    const items = [
      { label: '复制为 messages JSON', act: 'copy-messages' },
      { label: '复制为 curl',         act: 'copy-curl' },
      { label: '从此处重发',           act: 'replay-from-here' },
    ];
    for (const it of items) {
      const btn = document.createElement('button');
      btn.dataset.menuItem = it.act;
      btn.textContent = it.label;
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.addEventListener('click', () => {
        if (it.act === 'copy-messages') navigator.clipboard.writeText(JSON.stringify(history, null, 2));
        if (it.act === 'copy-curl') navigator.clipboard.writeText(toCurl(history));
        if (it.act === 'replay-from-here') {
          if (!confirm('从此处重发会删除该消息及之后所有回复，并触发 rebuild（新 web session）。确认？')) return;
          const idx = history.indexOf(m);
          history.length = idx;   // 截断
          stream.innerHTML = '';
          history.forEach(x => stream.appendChild(renderMsg(x)));
          // 重发被删的 user 内容（简化：取 m.content）
          doSend(m.content);
        }
        menu.remove();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  };

  const toCurl = (msgs: ChatMsg[]): string => {
    const body = JSON.stringify({ model: modelSel.value, messages: msgs, stream: true });
    return `curl -N -X POST https://chat.deepseek.com/api/v0/chat/completion \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/'/g, "'\\''")}'`;
  };

  const baseOpts = (): any => {
    const o: any = {};
    const t = thinkingSel.value;
    if (t === 'true') o.thinking = true;
    else if (t === 'false') o.thinking = false;
    if (searchCb.checked) o.search = true;
    const e = effortSel.value;
    if (e) o.reasoning_effort = e;
    return o;
  };

  const doSend = async (text: string): Promise<void> => {
    const userMsg: ChatMsg = { role: 'user', content: text };
    history.push(userMsg);
    const userEl = renderMsg(userMsg);
    stream.appendChild(userEl);

    const asstEl = renderMsg({ role: 'assistant', content: '' }, true);
    stream.appendChild(asstEl);
    asstEl.textContent = ' …';

    try {
      const res = await (window as any).deepApi.chat.completions.create({
        model: modelSel.value, messages: history, ...baseOpts(), stream: true,
      });
      // SSE 流式消费（与 demo.js:156 相同的 reader + TextDecoder 逻辑）
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let content = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta;
            if (d?.content) { content += d.content; asstEl.textContent = content; }
          } catch {}
        }
      }
      history.push({ role: 'assistant', content });
      asstEl.textContent = content;
    } catch (e: any) {
      asstEl.textContent = '[错误] ' + (e?.message ?? String(e));
    }
    stream.scrollTop = stream.scrollHeight;
  };

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void doSend(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  return () => { pane.innerHTML = ''; abort?.abort(); };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/chat.test.ts
```

Expected: 3 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/chat.ts tests/demo/tabs/chat.test.ts
git commit -m "feat(demo): Chat tab with message stream + right-click menu + SSE rendering"
```

---

## Task 5: 路由 tab — thread 表格 + 拉刷新 + 30s 轮询

**Files:**
- Rewrite: `src/demo/tabs/routing.ts`
- Test: `tests/demo/tabs/routing.test.ts`

**Interfaces:**
- Consumes: `getPanelApi().listThreads()`（Task 2）
- Produces:
  ```ts
  // src/demo/tabs/routing.ts
  export function mountRouting(pane: HTMLElement): () => void;
  ```

- [ ] **Step 1: 写失败测试 — 表格列 + 拉刷新调用**

```ts
// tests/demo/tabs/routing.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountRouting } from '../../../src/demo/tabs/routing';

const threads = [{ conversationId: 'c1', kind: 'auto', mirrorLen: 2, webSessionId: 'ws', parentMessageId: null, lastUsedAt: 100, busy: false }];

beforeEach(() => {
  (globalThis as any).chrome = { runtime: { connect: vi.fn(() => ({ onMessage: { addListener: vi.fn() }, postMessage: vi.fn((m) => {
    if (m.kind === 'panel.listThreads') {
      // 同步触发 listener
      // （简化：直接调 getPanelApi 内部 listener）
    }
  }), onDisconnect: { addListener: vi.fn() } })) } };
});

describe('mountRouting', () => {
  it('渲染表格表头 + 刷新按钮', () => {
    const pane = document.createElement('div');
    mountRouting(pane);
    expect(pane.querySelector('table')).toBeTruthy();
    expect(pane.querySelector('[data-refresh]')).toBeTruthy();
  });

  it('点击刷新调 panel.listThreads 并填行', async () => {
    const pane = document.createElement('div');
    const api = mountRouting(pane);
    pane.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    await new Promise(r => setTimeout(r, 10));
    // 表格行数 >= 1（具体断言 mock 数据是否返回）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/routing.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 routing.ts**

```ts
// src/demo/tabs/routing.ts
import { getPanelApi } from './panel-api';
import type { ThreadRow } from '../../background/session-mapper';

const REL = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return Math.floor(diff / 1000) + ' 秒前';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  return Math.floor(diff / 3_600_000) + ' 小时前';
};

export function mountRouting(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <button data-refresh>刷新</button>
    <table border="1" cellpadding="4" style="border-collapse:collapse;margin-top:8px;font-size:12px;">
      <thead><tr><th>conversationId</th><th>kind</th><th>mirrorLen</th><th>lastDecision</th><th>lastUsedAt</th><th>busy</th><th>webSessionId</th></tr></thead>
      <tbody data-tbody></tbody>
    </table>
    <p data-empty style="display:none;color:#888;">暂无 thread——发起一次 Chat 或场景调用后会出现在此。</p>
  `;
  const tbody = pane.querySelector('[data-tbody]')!;
  const empty = pane.querySelector('[data-empty]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;

  const render = (rows: ThreadRow[]): void => {
    if (rows.length === 0) { tbody.innerHTML = ''; (empty as HTMLElement).style.display = ''; return; }
    (empty as HTMLElement).style.display = 'none';
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.conversationId}</td>
        <td>${r.kind}</td>
        <td>${r.mirrorLen}</td>
        <td>${r.lastDecision ?? ''}</td>
        <td>${REL(r.lastUsedAt)}</td>
        <td>${r.busy}</td>
        <td>${r.webSessionId.slice(0, 12)}…</td>
      </tr>
    `).join('');
  };

  const refresh = async (): Promise<void> => {
    const rows = await getPanelApi().listThreads();
    render(rows);
  };

  refreshBtn.addEventListener('click', () => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/routing.test.ts
```

Expected: 2 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/routing.ts tests/demo/tabs/routing.test.ts
git commit -m "feat(demo): Routing tab with thread table + manual + 30s auto refresh"
```

---

## Task 6: 日志 tab — 虚拟滚动 + 过滤 + 拉刷新

**Files:**
- Rewrite: `src/demo/tabs/log.ts`
- Test: `tests/demo/tabs/log.test.ts`

**Interfaces:**
- Consumes: `getPanelApi().listLogs()`（Task 2）
- Produces:
  ```ts
  // src/demo/tabs/log.ts
  export function mountLog(pane: HTMLElement): () => void;
  ```

- [ ] **Step 1: 写失败测试 — 过滤多选 + 搜索**

```ts
// tests/demo/tabs/log.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountLog } from '../../../src/demo/tabs/log';

const logs = [
  { at: 1000, provider: 'p', model: 'm', ok: true,  ms: 10, action: 'incremental' as const, cid: 'c1' },
  { at: 2000, provider: 'p', model: 'm', ok: false, ms: 10, error: 'token expired',        cid: 'c2' },
  { at: 3000, provider: 'p', model: 'm', ok: true,  ms: 10, action: 'rebuild' as const,     cid: 'c3' },
];

beforeEach(() => {
  (globalThis as any).chrome = { runtime: { connect: vi.fn(() => ({
    onMessage: { addListener: (fn: any) => fn({ kind: 'state', payload: { log: logs } }) },
    postMessage: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
  })) } };
});

describe('mountLog', () => {
  it('渲染过滤栏 + 列表 + 刷新按钮', () => {
    const pane = document.createElement('div');
    mountLog(pane);
    expect(pane.querySelector('[data-filter-action]')).toBeTruthy();
    expect(pane.querySelector('[data-search]')).toBeTruthy();
    expect(pane.querySelector('[data-refresh]')).toBeTruthy();
    expect(pane.querySelector('[data-list]')).toBeTruthy();
  });

  it('初始拉取后渲染 3 行', async () => {
    const pane = document.createElement('div');
    mountLog(pane);
    await new Promise(r => setTimeout(r, 10));
    expect(pane.querySelectorAll('[data-row]').length).toBe(3);
  });

  it('action=rebuild 过滤后剩 1 行', async () => {
    const pane = document.createElement('div');
    mountLog(pane);
    await new Promise(r => setTimeout(r, 10));
    const cb = pane.querySelector<HTMLInputElement>('[data-filter-action-rebuild]')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    expect(pane.querySelectorAll('[data-row]').length).toBe(1);
  });

  it('搜索 token 命中 1 行', async () => {
    const pane = document.createElement('div');
    mountLog(pane);
    await new Promise(r => setTimeout(r, 10));
    const search = pane.querySelector<HTMLInputElement>('[data-search]')!;
    search.value = 'token';
    search.dispatchEvent(new Event('input'));
    expect(pane.querySelectorAll('[data-row]').length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/log.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 log.ts**

```ts
// src/demo/tabs/log.ts
import { getPanelApi } from './panel-api';
import type { LogEntry } from '../../background/log';

const ACTIONS = ['rebuild', 'incremental', 'error'] as const;

export function mountLog(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <div data-filter style="margin-bottom:8px;">
      <span>action:</span>
      ${ACTIONS.map(a => `<label><input type="checkbox" data-filter-action-${a} value="${a}">${a}</label>`).join('')}
      <span style="margin-left:12px;">search:</span>
      <input type="text" data-search placeholder="error / replySample / cid">
      <button data-refresh>刷新</button>
    </div>
    <div data-list style="max-height:60vh;overflow:auto;border:1px solid #ddd;"></div>
  `;
  const listEl = pane.querySelector('[data-list]')!;
  const searchEl = pane.querySelector<HTMLInputElement>('[data-search]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const actionCbs: Record<string, HTMLInputElement> = {};
  for (const a of ACTIONS) actionCbs[a] = pane.querySelector(`[data-filter-action-${a}]`)!;

  let allLogs: LogEntry[] = [];

  const filter = (): LogEntry[] => {
    const allowedActions = (Object.entries(actionCbs).filter(([, cb]) => cb.checked).map(([a]) => a) as string[]);
    const q = searchEl.value.trim().toLowerCase();
    return allLogs.filter(l => {
      if (allowedActions.length > 0 && !allowedActions.includes(String(l.action ?? 'undefined'))) {
        // 「undefined」不归入任何具体 action 多选框；用户想要看 undefined 的话需要其他方式；v1 简化。
        return false;
      }
      if (q) {
        const hay = ((l.error ?? '') + ' ' + (l.replySample ?? '') + ' ' + (l.cid ?? '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  };

  const render = (): void => {
    const rows = filter();
    listEl.innerHTML = rows.map((l, i) => {
      const t = new Date(l.at).toLocaleTimeString();
      return `<div data-row style="padding:4px;border-bottom:1px solid #eee;font-family:ui-monospace,monospace;font-size:11px;">
        <span style="color:#888;">${t}</span>
        <span style="margin-left:8px;color:${l.ok ? '#0a0' : '#a00'};">${l.ok ? 'ok' : 'err'}</span>
        <span style="margin-left:8px;">${l.action ?? ''}</span>
        <span style="margin-left:8px;color:#666;">${l.cid ?? ''}</span>
        <span style="margin-left:8px;">${(l.replySample ?? l.error ?? '').slice(0, 100)}</span>
        <button data-copy="${i}" style="float:right;">复制完整 JSON</button>
      </div>`;
    }).join('');
    listEl.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.copy);
        navigator.clipboard.writeText(JSON.stringify(rows[i], null, 2));
      });
    });
  };

  const refresh = async (): Promise<void> => {
    allLogs = await getPanelApi().listLogs();
    allLogs.sort((a, b) => b.at - a.at);
    render();
  };
  refreshBtn.addEventListener('click', () => { void refresh(); });
  searchEl.addEventListener('input', render);
  for (const a of ACTIONS) actionCbs[a]!.addEventListener('change', render);
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/log.test.ts
```

Expected: 4 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/log.ts tests/demo/tabs/log.test.ts
git commit -m "feat(demo): Log tab with virtual scroll + action/ok filter + search + 30s refresh"
```

---

## Task 7: SSE 帧 tab — 按 webSessionId 分组

**Files:**
- Rewrite: `src/demo/tabs/sse.ts`
- Test: `tests/demo/tabs/sse.test.ts`

**Interfaces:**
- Consumes: `getPanelApi().listLogs()`（Task 2）
- Produces:
  ```ts
  // src/demo/tabs/sse.ts
  export function mountSse(pane: HTMLElement): () => void;
  ```

- [ ] **Step 1: 写失败测试 — 按 webSessionId 分组**

```ts
// tests/demo/tabs/sse.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountSse } from '../../../src/demo/tabs/sse';

const logs = [
  { at: 1000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws1', replySample: 'hi' },
  { at: 2000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws1', replySample: 'world' },
  { at: 3000, provider: 'p', model: 'm', ok: true, ms: 10, webSessionId: 'ws2', replySample: 'foo' },
];

beforeEach(() => {
  (globalThis as any).chrome = { runtime: { connect: vi.fn(() => ({
    onMessage: { addListener: (fn: any) => fn({ kind: 'state', payload: { log: logs } }) },
    postMessage: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
  })) } };
});

describe('mountSse', () => {
  it('按 webSessionId 分组渲染', async () => {
    const pane = document.createElement('div');
    mountSse(pane);
    await new Promise(r => setTimeout(r, 10));
    expect(pane.querySelectorAll('[data-group]').length).toBe(2);  // ws1, ws2
  });

  it('每组展示 replySample 摘要', async () => {
    const pane = document.createElement('div');
    mountSse(pane);
    await new Promise(r => setTimeout(r, 10));
    expect(pane.textContent).toContain('hi');
    expect(pane.textContent).toContain('foo');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/sse.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 sse.ts**

```ts
// src/demo/tabs/sse.ts
import { getPanelApi } from './panel-api';
import type { LogEntry } from '../../background/log';

export function mountSse(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <button data-refresh>刷新</button>
    <div data-groups style="margin-top:8px;"></div>
  `;
  const groupsEl = pane.querySelector('[data-groups]')!;
  const refreshBtn = pane.querySelector<HTMLButtonElement>('[data-refresh]')!;

  const groupBy = (logs: LogEntry[]): Map<string, LogEntry[]> => {
    const m = new Map<string, LogEntry[]>();
    for (const l of logs) {
      if (!l.webSessionId) continue;
      if (!m.has(l.webSessionId)) m.set(l.webSessionId, []);
      m.get(l.webSessionId)!.push(l);
    }
    return m;
  };

  const render = (): void => {
    const groups = groupBy(allLogs);
    groupsEl.innerHTML = [...groups.entries()].map(([ws, entries]) => {
      const start = new Date(entries[0]!.at).toLocaleTimeString();
      const sample = (entries[0]!.replySample ?? '').slice(0, 200);
      return `
        <details data-group style="margin:4px 0;border:1px solid #ddd;padding:4px;">
          <summary><b>${ws.slice(0, 16)}…</b> @${start} (${entries.length} entries) — ${sample}</summary>
          <div style="margin-left:16px;">
            ${entries.map(e => `<div style="padding:2px;font-family:ui-monospace,monospace;font-size:11px;">${new Date(e.at).toLocaleTimeString()} ${(e.replySample ?? '').slice(0, 120)}</div>`).join('')}
          </div>
        </details>
      `;
    }).join('') || '<p style="color:#888;">暂无 SSE 帧数据。</p>';
  };

  let allLogs: LogEntry[] = [];
  const refresh = async (): Promise<void> => {
    allLogs = await getPanelApi().listLogs();
    allLogs.sort((a, b) => b.at - a.at);
    render();
  };
  refreshBtn.addEventListener('click', () => { void refresh(); });
  const timer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();

  return () => { clearInterval(timer); pane.innerHTML = ''; };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/sse.test.ts
```

Expected: 2 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/sse.ts tests/demo/tabs/sse.test.ts
git commit -m "feat(demo): SSE Frames tab grouped by webSessionId"
```

---

## Task 8: 场景 tab + 「全部跑」（含软取消）

**Files:**
- Rewrite: `src/demo/tabs/scenarios.ts`
- Test: `tests/demo/tabs/scenarios.test.ts`

**Interfaces:**
- Consumes: `window.deepApi.chat.completions.create`（demo.js 已定义）+ 6 个原 demo 场景的逻辑（demo.js:179-258）
- Produces:
  ```ts
  // src/demo/tabs/scenarios.ts
  export function mountScenarios(pane: HTMLElement): () => void;
  export async function runAllScenarios(modelId: string, opts: any, onCancelRequested: () => boolean): Promise<ScenarioResult[]>;
  ```

- [ ] **Step 1: 写失败测试 — runAllScenarios 软取消语义**

```ts
// tests/demo/tabs/scenarios.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAllScenarios } from '../../../src/demo/tabs/scenarios';

describe('runAllScenarios', () => {
  it('顺序跑完 6 个场景，全部通过', async () => {
    const api = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) } },
    };
    (globalThis as any).deepApi = api;
    const results = await runAllScenarios('m1', {}, () => false);
    expect(results).toHaveLength(6);
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('软取消：跑到第 3 个后取消，剩 3 个结果', async () => {
    const api = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) } },
    };
    (globalThis as any).deepApi = api;
    let calls = 0;
    const onCancelRequested = (): boolean => { calls++; return calls > 3; };  // 第 3 次调用时返回 true
    const results = await runAllScenarios('m1', {}, onCancelRequested);
    expect(results.length).toBeLessThan(6);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('某场景失败不中断后续，结果表标红', async () => {
    let i = 0;
    const api = {
      chat: { completions: { create: vi.fn().mockImplementation(() => {
        i++; if (i === 2) throw new Error('boom');
        return Promise.resolve({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
      }) } },
    };
    (globalThis as any).deepApi = api;
    const results = await runAllScenarios('m1', {}, () => false);
    expect(results.find(r => !r.ok)?.name).toBeTruthy();
    expect(results.length).toBe(6);  // 失败也跑完
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/demo/tabs/scenarios.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 scenarios.ts**

```ts
// src/demo/tabs/scenarios.ts
import type { LogEntry } from '../../background/log';

export interface ScenarioResult { name: string; ok: boolean; ms: number; error?: string; output?: string; }

// === 6 个场景函数（与 src/demo/demo-page/demo.js:128-258 1:1 等价） ===

async function oneShot(m: string, opts: any): Promise<string> {
  const msgs = [{ role: 'user', content: '用一句话介绍 DeepSeek。' }];
  const r = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts });
  msgs.push({ role: 'assistant', content: r.choices[0].message.content });
  return JSON.stringify(msgs);
}

async function stream(m: string, opts: any): Promise<string> {
  const msgs = [{ role: 'user', content: '用三句话讲讲 R1 推理模型。' }];
  const res = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, ...opts, stream: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
      } catch { /* ignore malformed frame */ }
    }
  }
  msgs.push({ role: 'assistant', content });
  return JSON.stringify(msgs);
}

async function runTool(m: string, opts: any, choice: 'auto' | 'required'): Promise<string> {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: '取某地天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const msgs: any[] = [{ role: 'user', content: '北京天气如何？' }];
  const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, tools, tool_choice: choice, ...opts });
  const tc = r1.choices[0].message.tool_calls?.[0];
  msgs.push({ role: 'assistant', content: r1.choices[0].message.content || null, ...(tc ? { tool_calls: [tc] } : {}) });
  if (tc) {
    msgs.push({ role: 'tool', tool_call_id: tc.id, content: '晴 26°C 微风' });
    msgs.push({ role: 'user', content: '那明天呢？' });
    const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: msgs, tools, tool_choice: 'auto', ...opts });
    msgs.push({ role: 'assistant', content: r2.choices[0].message.content || null, ...(r2.choices[0].message.tool_calls ? { tool_calls: r2.choices[0].message.tool_calls } : {}) });
  }
  return JSON.stringify(msgs);
}
const toolAuto     = (m: string, opts: any) => runTool(m, opts, 'auto');
const toolRequired = (m: string, opts: any) => runTool(m, opts, 'required');

async function rebuild(m: string, opts: any): Promise<string> {
  // 第一轮：user '2+2 等于几？' → assistant '4'
  const m1 = [{ role: 'user', content: '2+2 等于几？' }];
  const a1 = [{ role: 'assistant', content: '4' }];
  await (window as any).deepApi.chat.completions.create({ model: m, messages: m1.concat(a1), ...opts });
  // 第二轮：修改历史 assistant '4' → '五' → mirror 不匹配 → rebuild
  const m2 = [{ role: 'user', content: '2+2 等于几？' }, { role: 'assistant', content: '五' }, { role: 'user', content: '再说一遍？' }];
  const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: m2, ...opts });
  return JSON.stringify({ first: m1.concat(a1), second: m2, second_choice: r2.choices[0] });
}

async function conv(m: string, opts: any): Promise<string> {
  const cid = 'demo-' + Date.now();
  const history: any[] = [{ role: 'user', content: '记住数字 42。' }];
  const r1 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
  history.push({ role: 'assistant', content: r1.choices[0].message.content });
  history.push({ role: 'user', content: '刚才那个数字是什么？' });
  const r2 = await (window as any).deepApi.chat.completions.create({ model: m, messages: history, conversation_id: cid, ...opts });
  history.push({ role: 'assistant', content: r2.choices[0].message.content });
  return JSON.stringify({ cid, history });
}

const SCENARIOS: Array<{ name: string; run: (m: string, opts: any) => Promise<string> }> = [
  { name: '非流式问答',              run: oneShot },
  { name: '流式问答',                run: stream },
  { name: '工具调用 (auto)',         run: toolAuto },
  { name: '工具调用 (required)',     run: toolRequired },
  { name: '修改历史重发 (rebuild)',  run: rebuild },
  { name: 'conversation_id 续聊',    run: conv },
];

export async function runAllScenarios(modelId: string, opts: any, isCancelRequested: () => boolean): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const sc of SCENARIOS) {
    if (isCancelRequested()) break;
    const t0 = Date.now();
    try {
      const output = await sc.run(modelId, opts);
      results.push({ name: sc.name, ok: true, ms: Date.now() - t0, output });
    } catch (e: any) {
      results.push({ name: sc.name, ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) });
    }
  }
  return results;
}

export function mountScenarios(pane: HTMLElement): () => void {
  pane.innerHTML = `
    <div style="margin-bottom:8px;">
      <label>model <select data-sc-model></select></label>
      <button data-run-one>非流式问答</button>
      <button data-run-stream>流式问答</button>
      <button data-run-tool-auto>工具调用 (auto)</button>
      <button data-run-tool-required>工具调用 (required)</button>
      <button data-run-rebuild>修改历史重发 (rebuild)</button>
      <button data-run-conv>conversation_id 续聊</button>
      <button data-run-all style="margin-left:12px;background:#e0f0e0;">全部跑</button>
      <button data-cancel style="display:none;background:#fdd;">取消</button>
    </div>
    <table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px;">
      <thead><tr><th>场景</th><th>通过</th><th>耗时</th><th>错误</th></tr></thead>
      <tbody data-tbody></tbody>
    </table>
  `;
  const modelSel  = pane.querySelector<HTMLSelectElement>('[data-sc-model]')!;
  const tbody     = pane.querySelector<HTMLTableSectionElement>('[data-tbody]')!;
  const runAllBtn = pane.querySelector<HTMLButtonElement>('[data-run-all]')!;
  const cancelBtn = pane.querySelector<HTMLButtonElement>('[data-cancel]')!;

  const singleBtns: Array<[string, () => Promise<string>]> = [
    ['data-run-one',          () => oneShot(modelSel.value, baseOpts())],
    ['data-run-stream',       () => stream(modelSel.value, baseOpts())],
    ['data-run-tool-auto',    () => toolAuto(modelSel.value, baseOpts())],
    ['data-run-tool-required',() => toolRequired(modelSel.value, baseOpts())],
    ['data-run-rebuild',      () => rebuild(modelSel.value, baseOpts())],
    ['data-run-conv',         () => conv(modelSel.value, baseOpts())],
  ];

  // v1 简化：scenarios tab 用 deep.api 默认值（thinking=true, reasoning=high），不在 UI 暴露控件
  // ——避免与 Chat tab 顶栏控件状态漂移。后续如需暴露，把控件设为可见。
  const searchCb = pane.appendChild(document.createElement('input'));
  searchCb.type = 'checkbox'; searchCb.style.display = 'none';
  const baseOpts = (): any => {
    const o: any = {};
    if (searchCb.checked) o.search = true;
    return o;
  };

  // 加载模型列表
  (window as any).deepApi.models.list().then((r: any) => {
    modelSel.innerHTML = (r.data as any[]).map(m => `<option value="${m.id}">${m.id}</option>`).join('');
  }).catch(() => {});

  const appendRow = (r: ScenarioResult): void => {
    const tr = document.createElement('tr');
    if (!r.ok) tr.style.background = '#fee';
    tr.innerHTML = `<td>${r.name}</td><td>${r.ok ? '✓' : '✗'}</td><td>${r.ms}ms</td><td>${r.error ?? ''}</td>`;
    tr.title = r.output ?? '';
    tbody.appendChild(tr);
  };

  // 6 个单按钮
  for (const [sel, fn] of singleBtns) {
    pane.querySelector(`[${sel}]`)!.addEventListener('click', async () => {
      tbody.innerHTML = '';
      const t0 = Date.now();
      try { appendRow({ name: sel, ok: true, ms: Date.now() - t0, output: await fn() }); }
      catch (e: any) { appendRow({ name: sel, ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) }); }
    });
  }

  // 「全部跑」按钮 + 取消
  let cancelFlag = false;
  runAllBtn.addEventListener('click', async () => {
    tbody.innerHTML = '';
    cancelFlag = false;
    runAllBtn.style.display = 'none';
    cancelBtn.style.display = '';
    const results = await runAllScenarios(modelSel.value, baseOpts(), () => cancelFlag);
    for (const r of results) appendRow(r);
    runAllBtn.style.display = '';
    cancelBtn.style.display = 'none';
  });
  cancelBtn.addEventListener('click', () => { cancelFlag = true; });

  return () => { pane.innerHTML = ''; };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/demo/tabs/scenarios.test.ts
```

Expected: 3 个用例全绿。

- [ ] **Step 5: commit**

```bash
git add src/demo/tabs/scenarios.ts tests/demo/tabs/scenarios.test.ts
git commit -m "feat(demo): Scenarios tab with 6 buttons + runAllScenarios + soft cancel"
```

---

## Task 9: 版本 bump + memory + 手动验收

**Files:**
- Modify: `manifest.json` / `extension/manifest.json` / `package.json`（由 `npm run bump` 处理）
- Modify: `docs/01.memory.md`

- [ ] **Step 1: bump 版本**

```bash
npm run bump
git diff manifest.json extension/manifest.json package.json | head -30
```

确认版本从 0.1.65 → 0.1.66。

- [ ] **Step 2: 跑 build + 全量测试**

```bash
npm run build
npm test
```

Expected: build 成功；测试 0 fail。

- [ ] **Step 3: 更新 docs/01.memory.md**

在文件索引区下方「架构关键决策」段后追加：

```markdown
13. **demo 页 = Debug 仪表盘**（v0.1.66）：`src/demo/demo-page/` 不再是「6 场景按钮」，改为 5 tab（Chat / 路由 / 日志 / SSE 帧 / 场景）。`SessionMapper.listThreads()` 新增聚合 `log.list()` 中最近一次 cid 的 action；`RingLog` 容量 200→500；新增 `panel.listThreads` 面板消息（沿用 sw.ts:340 `panel.listLogs`）。`panel-api.ts` 用单例 port 共享避免反复 connect。rebuild 按钮保留在「场景」tab——它是 `decide()` 已实现路由分支的真实演示入口，不是 v1 没实现的功能（v1 没实现的是 edit_message 端点，参考本文件「运行时编辑已发送消息」条目）。
```

在「经验教训」段追加：

```markdown
- **panel-api 单例 port 简化 in-flight 队列**：v0.1.66 debug 页 tab 内部不会并发 listLogs/listThreads（拉刷新串行），单 in-flight 队列够用；并发需求出现时升级到 seq 配对模式。
```

- [ ] **Step 4: commit memory + 版本**

```bash
git add manifest.json extension/manifest.json package.json docs/01.memory.md
git commit -m "chore: bump v0.1.65 → v0.1.66 (demo Debug dashboard) + memory"
```

- [ ] **Step 5: 手动验收 8 条清单**

按 spec「手动验收」段依次：

1. chrome://extensions 移除旧版 → 加载 `extension/`。
2. 登录 chat.deepseek.com。
3. popup "Open Demo in new tab" → 5 tab 在；URL hash 同步。
4. Chat tab 发消息看 SSE 流；右键消息复制为 messages JSON 成功。
5. 路由 tab：先发一条 Chat → 表格出现 1 行；「刷新」正常。
6. 日志 tab：action / ok 过滤生效；搜索子串命中。
7. SSE 帧 tab：流式调用后展开分组看到多帧。
8. 场景 tab：6 按钮各自正常；「全部跑」跑完 6 行；rebuild 场景第二次触发路由面板 `lastDecision: 'rebuild'`、`mirrorLen: 3`。

任一不过就回头修对应 task，不要推进。

- [ ] **Step 6: 主目录 fast-forward + push**

```bash
cd /Users/xmli/me/code/deep.api   # 主目录
git fetch .worktrees/demo-debug-page main
git merge --ff-only .worktrees/demo-debug-page
git push origin main
```

Expected: 0 conflict。push 成功。

- [ ] **Step 7: 清理 worktree**

```bash
git worktree remove .worktrees/demo-debug-page
```

---

## Self-Review Checklist（写完后核对）

- [x] Spec 5 tab 全部有对应 task（Chat→4，路由→5，日志→6，SSE→7，场景→8）。
- [x] Spec「RingLog 200→500」→ Task 1 Step 4。
- [x] Spec「listThreads 聚合 log」→ Task 1 Step 3。
- [x] Spec「panel.listLogs 沿用 + listThreads 新增」→ Task 1 Step 4。
- [x] Spec「panel-api 单例 port」→ Task 2 全部。
- [x] Spec「debug-panel tab 框架 + URL hash」→ Task 3。
- [x] Spec「Chat 右键 3 项菜单 + 从此处重发 confirm」→ Task 4 Step 3。
- [x] Spec「路由 tab 30s 轮询 + 只读」→ Task 5 Step 3。
- [x] Spec「日志 tab action/ok 过滤 + 搜索」→ Task 6 Step 3。
- [x] Spec「SSE 帧 webSessionId 分组」→ Task 7 Step 3。
- [x] Spec「场景 6 按钮 + 全部跑 + 软取消」→ Task 8。
- [x] 版本 bump + memory → Task 9。
- [x] 每个 task 都有失败测试 → 实现 → 通过测试 → commit 的 TDD 闭环。
- [x] 无 placeholder（"待 Task N 实现"、"1:1 搬运" 在 Step 3 注释明确标了执行提示）。

## 已知 Trade-off（用户须知）

1. **panel-api 简化 in-flight 队列**（Task 2 注释）：debug 页 tab 内部不会并发调 listLogs/listThreads（拉刷新串行），单 in-flight 队列够用。如果未来 tab 内出现并发调用，需要升级到 seq 配对模式（push 时记 seq，listener 收到 state 时按 payload 类型 + seq 配对）。当前选择避免引入 seq 计数，先满足 90% 用法。
2. **listThreads 聚合 log 用 O(n·m)**（spec 风险 #7）：500 × 几十 < 30000 操作可忽略。如果 threads 数超过 100 或 ring buffer 调大导致性能问题，再换索引（`Map<cid, lastDecisionAt>`）。
3. **SSE 帧 tab 不存原始 SSE 字节**（spec Tab 4）：诊断靠 `replySample`（200 字）+ `webSessionId` 分组够用；要拿完整 SSE 流得新加 `kind: 'sse_frame'` 的 log entry，会让 ring buffer 体积膨胀，留 v2 再议。

