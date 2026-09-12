# 断流自动续接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeepSeek 网页生成中途断流（`INCOMPLETE`/`generation_err`）时，deep.api 自动调 `/chat/continue` 续接，客户端视角是一条无重复、无缺口的连续流（spec §1）。

**Architecture:** 续接循环放进 `runExclusiveStream` 的锁内（单点）：首段耗尽后按「可续接」条件调用 adapter 新增的 `continueStream()`；续接流复用现有 SSE parser，并以「当前 message 的已发**原始**字符数」为 skip 裁剪快照重发内容（spec §3.3）；失败重试上限 3 次、间隔 500ms（spec §3.4）。消费侧（`consumeEvent`/`encodeStream`）零改动。

**Tech Stack:** TypeScript / Chrome MV3 / vitest / esbuild（bun 管理依赖）。无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-12-continue-on-incomplete-design.md` — 每条需求可回溯到 spec 章节（本 plan 引用 § 号）。

---

## Global Constraints

- **Worktree**：按 AGENTS.md §13 在仓库外的 worktree 内开发（`git worktree add -b feat/continue-on-incomplete .worktrees/<name> main`），编码期间不改主目录；合并流程按 §13。
- **命令**：`bun run test` / `bun run build` / `bun run bump`（README；`npm/pnpm install` 会被 preinstall 拒绝）。
- **无新依赖**；不引入新测试框架。
- **注释风格**：关键改动加日期标记注释，格式 `2026-09-12（feat/continue-on-incomplete）：<原因>`（项目惯例）。
- **Commit message 首行 ≤72 字符**（`.git/hooks/commit-msg` 强制）。
- **测试 fixture 用自洽合成 SSE**（抓包原稿含 `…` 省略，不能当字符级 fixture；spec §4）。
- **类型/命名（跨任务契约）**：
  - `ContinueSkip = { thinkingChars: number; responseChars: number; expectMessageId?: number | string }`（定义在 `providers/adapter.ts`）
  - `completionEvents(body, timeoutMs, onReady, skip?: ContinueSkip)`
  - `continuePayload(session, messageId) → { chat_session_id, message_id, fallback_to_resume: true }`
  - `continueHeaders(token) → Record<string,string>`（`baseHeaders` + x-client 指纹，**无 PoW**）
  - `ProviderAdapter.continueStream?(ctx, session, messageId, skip): AsyncIterable<ProviderStreamEvent>`
  - `RunState.continueAttempts / emittedThinkChars / emittedContentChars`（初值 0）
  - 常量 `MAX_CONTINUE_ATTEMPTS = 3` / `CONTINUE_DELAY_MS = 500` / `RESUMABLE_REASONS = Set{'generation_err','incomplete_status'}`
  - `LogEntry.continueAttempts?: number`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/background/providers/adapter.ts` | MODIFY | 加 `ContinueSkip` 类型 + `ProviderAdapter.continueStream?` 可选方法 |
| `src/background/providers/deepseek/sse-patch.ts` | MODIFY | `completionEvents` 第 4 参 `skip`；快照裁剪（只裁事件内容、不改状态）；带 skip 流末无终态 → stream_error |
| `src/background/providers/deepseek/client.ts` | MODIFY | `continuePayload` / `continueHeaders`（x-client 指纹，无 PoW） |
| `src/background/providers/deepseek/adapter.ts` | MODIFY | `continueStream` 实现；`withPowHeaders` 复用它 + PoW |
| `src/background/router.ts` | MODIFY | RunState 字段、常量、锁内续接 wrapper（计数/累计改写/续接循环）、done/LogEntry 带 continueAttempts |
| `src/background/log.ts` | MODIFY | `LogEntry.continueAttempts` |
| `src/popup/snippet.ts` | MODIFY | `FORENSIC_FIELDS` 加 `continueAttempts` |
| `tests/unit/sse-patch.test.ts` | MODIFY | 单测 1-6（skip 裁剪/补齐/无快照/fallback/终态/回归） |
| `tests/unit/deepseek-adapter.test.ts` | MODIFY | client payload/headers + adapter continueStream 单测 |
| `tests/integration/router.test.ts` | MODIFY | 集成 7-16（续接成功/连续/上限/永久错误/流式/回归/DSML/无 id/fallback/空流） |

---

## Task 1: Parser — 快照裁剪 + 续接段终态要求

**Files:**
- Modify: `src/background/providers/adapter.ts`（只加类型）
- Modify: `src/background/providers/deepseek/sse-patch.ts`
- Test: `tests/unit/sse-patch.test.ts`

**Interfaces:**
- Consumes: 现有 `ProviderStreamEvent`、`extractReadyIds`、`applySnapshot`
- Produces: `ContinueSkip`（export，providers/adapter.ts）；`completionEvents(body, timeoutMs, onReady, skip?: ContinueSkip)`；makeProcessor 快照分支裁剪（裁剪不参与状态判定）

- [ ] **Step 1: 加 `ContinueSkip` 类型（providers/adapter.ts）**

在 `ProviderStreamEvent` 定义之后（同文件 export）：

```ts
/** 2026-09-12（feat/continue-on-incomplete）：续接段的快照裁剪参数（spec §3.3）。
 *  thinkingChars/responseChars = 当前 response message 已发出的**原始**字符数（DSML 归一化前）；
 *  expectMessageId = 请求续接的 message id（ready id 不匹配时禁用裁剪——fail-safe）。 */
export interface ContinueSkip {
  thinkingChars: number;
  responseChars: number;
  expectMessageId?: number | string;
}
```

- [ ] **Step 2: 写失败测试（sse-patch.test.ts 末尾追加 describe）**

先给文件顶部的测试 helper 扩参（现有 `collectSse(text)` → `collectSse(text, skip?)`）：

```ts
// 顶部 import 追加 ContinueSkip 类型
import type { ProviderStreamEvent, ContinueSkip } from '../../src/background/providers/adapter';

// 现有 collectSse 签名改为：
async function collectSse(text: string, skip?: ContinueSkip): Promise<ProviderStreamEvent[]> {
  const chunks: Uint8Array[] = [];
  for (const block of text.split('\n\n')) chunks.push(new TextEncoder().encode(block + '\n\n'));
  const iter = (async function* () { for (const c of chunks) yield c; })();
  const evs: ProviderStreamEvent[] = [];
  for await (const ev of completionEvents(iter, 1000, () => {}, skip)) evs.push(ev);
  return evs;
}
```

文件末尾追加：

```ts
// 2026-09-12（feat/continue-on-incomplete）：续接段快照裁剪（spec §3.3）。
// 快照会重发断流前已发出的内容——按「当前 message 已发原始字符数」裁剪，否则客户端收到重复文本。
describe('续接段快照裁剪（feat/continue-on-incomplete）', () => {
  it('skip 恰等：快照内容零 emit；紧随的简写增量不因裁剪丢帧', async () => {
    const sse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":2,"type":"THINK","content":"一二三四五六七八九十"},{"id":3,"type":"RESPONSE","content":"Both"}]}}}\n\n',
      'data: {"v":" more"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const evs = await collectSse(sse, { thinkingChars: 10, responseChars: 4, expectMessageId: 4 });
    expect(evs.filter((e) => e.kind === 'think_delta')).toHaveLength(0);
    expect(evs.filter((e) => e.kind === 'content_delta').map((e: any) => e.content)).toEqual([' more']);
    // 状态按裁剪前快照设置：简写走形态 2，不落 unknown 兜底
    const stats = evs.find((e) => e.kind === 'stream_stats') as any;
    expect(stats.paths).not.toContain('unknown:v');
    expect(stats.paths).toContain('snapshot:fragments');
  });

  it('部分送达补齐：skip response=2，快照 "Both" → emit "th"', async () => {
    const sse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":2,"type":"RESPONSE","content":"Both"}]}}}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const evs = await collectSse(sse, { thinkingChars: 0, responseChars: 2, expectMessageId: 4 });
    expect(evs.filter((e) => e.kind === 'content_delta').map((e: any) => e.content)).toEqual(['th']);
  });

  it('无快照的续接流：skip 不消耗，带 p 的 appends 原样 emit', async () => {
    const sse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" new"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const evs = await collectSse(sse, { thinkingChars: 10, responseChars: 4, expectMessageId: 4 });
    expect(evs.filter((e) => e.kind === 'content_delta').map((e: any) => e.content)).toEqual([' new']);
  });

  it('fallback 保护（fail-safe）：expectMessageId 不匹配 / ready 缺席 → 不裁剪', async () => {
    const sse = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":2,"type":"RESPONSE","content":"Both"}]}}}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const mismatch = await collectSse(sse, { thinkingChars: 0, responseChars: 4, expectMessageId: 99 });
    expect(mismatch.filter((e) => e.kind === 'content_delta').map((e: any) => e.content)).toEqual(['Both']);
    const matched = await collectSse(sse, { thinkingChars: 0, responseChars: 4, expectMessageId: 4 });
    expect(matched.filter((e) => e.kind === 'content_delta')).toHaveLength(0);
    // ready 缺席（无 id 可比）→ 同样不裁剪
    const noReady = await collectSse(
      'data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"Both"}]}}}\n\n',
      { thinkingChars: 0, responseChars: 4, expectMessageId: 4 },
    );
    expect(noReady.filter((e) => e.kind === 'content_delta').map((e: any) => e.content)).toEqual(['Both']);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test tests/unit/sse-patch.test.ts`
Expected: 用例 1（think 未被裁）与 4（matched 未裁剪）FAIL；其余因「不裁剪=全量 emit」而平凡通过。

- [ ] **Step 4: 实现裁剪（sse-patch.ts）**

`completionEvents` 签名与 makeProcessor 调用（当前第 4 参不存在，新增）：

```ts
export async function* completionEvents(
  body: AsyncIterable<Uint8Array>, timeoutMs: number,
  onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void,
  skip?: ContinueSkip,
): AsyncIterable<ProviderStreamEvent> {
  const dec = new TextDecoder();
  const { processBlock, stats } = makeProcessor(onReady, skip);
```

文件顶部 import 追加：`import type { ContinueSkip, ProviderStreamEvent } from '../adapter';`（替换现有 `import type { ProviderStreamEvent } from '../adapter';`）。

`makeProcessor` 签名与内部新增（在 `const stats = {...}` 之后）：

```ts
function makeProcessor(
  onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void,
  skip?: ContinueSkip,
): {
  processBlock(block: string): ProviderStreamEvent[];
  stats: { /* 保持不变 */ };
} {
  // ...现有 stats 定义...
  // 2026-09-12（feat/continue-on-incomplete）：续接段快照裁剪（spec §3.3）。
  // 只裁剪来自快照的事件内容；allowTrim 为 fail-safe——ready 出现且 id 与请求一致才开裁剪。
  let remainingThink = skip?.thinkingChars ?? 0;
  let remainingContent = skip?.responseChars ?? 0;
  let allowTrim = false;
  const trimSnapshot = (events: ProviderStreamEvent[]): ProviderStreamEvent[] => {
    if (!allowTrim) return events;
    const kept: ProviderStreamEvent[] = [];
    for (const e of events) {
      if (e.kind === 'think_delta' && remainingThink > 0) {
        const drop = Math.min(remainingThink, e.content.length);
        remainingThink -= drop;
        const rest = e.content.slice(drop);
        if (rest !== '') kept.push({ ...e, content: rest });
      } else if (e.kind === 'content_delta' && remainingContent > 0) {
        const drop = Math.min(remainingContent, e.content.length);
        remainingContent -= drop;
        const rest = e.content.slice(drop);
        if (rest !== '') kept.push({ ...e, content: rest });
      } else {
        kept.push(e);
      }
    }
    return kept;
  };
```

ready 分支（`if (!sentReady)` 内，`out.push({ kind: 'message_id' ... })` 之前）加：

```ts
          // 续接裁剪开关：仅当 ready id 与请求的 expectMessageId 一致（fail-safe，spec §3.3）。
          if (skip !== undefined && skip.expectMessageId !== undefined
            && String(ids.responseMessageId) === String(skip.expectMessageId)) {
            allowTrim = true;
          }
```

快照分支（`const snap = tree.applySnapshot(d);` 处）改为：

```ts
            const snap = tree.applySnapshot(d);
            if (snap.length > 0) {
              stats.paths.add('snapshot:fragments');
              lastPath = 'response/fragments/-1/content';
              lastOp = 'APPEND';
              // 2026-09-12（feat/continue-on-incomplete）：裁剪只作用于事件内容，不参与状态判定——
              // 用裁剪前的 snap.length 判断（「快照恰被全吞」是续接的正常情形，spec §3.3）。
              out.push(...trimSnapshot(snap));
            } else {
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test tests/unit/sse-patch.test.ts`
Expected: PASS（含既有全部用例）。

- [ ] **Step 6: 写失败测试（终态要求，同文件末尾追加）**

```ts
// 2026-09-12（feat/continue-on-incomplete）：续接段成功判据（spec §3.4）——
// 空 200 / 非 SSE / 无终态断连不得被当成功（否则客户端拿到被截断的部分回复）。
describe('续接段终态要求（feat/continue-on-incomplete）', () => {
  it('带 skip 的流末无终态 → 合成 stream_error；有 FINISHED → 无错误', async () => {
    const noTerminal = await collectSse(
      'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
      { thinkingChars: 0, responseChars: 0, expectMessageId: 4 },
    );
    const errs = noTerminal.filter((e) => (e as any).kind === 'stream_error');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ reason: 'incomplete_status', message: 'resume ended without terminal status' });

    const finished = await collectSse(
      [
        'event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
      ].join(''),
      { thinkingChars: 0, responseChars: 0, expectMessageId: 4 },
    );
    expect(finished.some((e) => (e as any).kind === 'stream_error')).toBe(false);
  });

  it('回归：skip 缺省 + 无终态 → 不合成 stream_error（首段行为不变）', async () => {
    const evs = await collectSse('event: ready\ndata: {"request_message_id":1,"response_message_id":4}\n\n');
    expect(evs.some((e) => (e as any).kind === 'stream_error')).toBe(false);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `bun run test tests/unit/sse-patch.test.ts`
Expected: 第一个用例 FAIL（无终态未合成 stream_error）；第二个通过（守卫场景）。

- [ ] **Step 8: 实现终态要求（sse-patch.ts 流末）**

当前流末块：

```ts
    if (!stats.error) {
      const terminal = stats.lastStatus ?? stats.lastQuasi;
      if (terminal !== null && terminal !== 'FINISHED') {
        yield { kind: 'stream_error', message: `DeepSeek stream incomplete (status=${terminal})`, reason: 'incomplete_status' };
      }
    }
```

改为：

```ts
    if (!stats.error) {
      const terminal = stats.lastStatus ?? stats.lastQuasi;
      if (terminal !== null && terminal !== 'FINISHED') {
        yield { kind: 'stream_error', message: `DeepSeek stream incomplete (status=${terminal})`, reason: 'incomplete_status' };
      } else if (skip !== undefined && terminal === null) {
        // 2026-09-12（feat/continue-on-incomplete）：续接段要求终态（spec §3.4）——空 200 /
        // 非 SSE / 无终态断连都不得被当成功。首段（skip 缺省）不受约束，行为不变。
        yield { kind: 'stream_error', message: 'resume ended without terminal status', reason: 'incomplete_status' };
      }
    }
```

- [ ] **Step 9: 全量测试 + 类型检查 + 提交**

Run: `bun run test && bunx tsc --noEmit`
Expected: 全绿（tsc 必须过——esbuild 不做类型检查，memory 教训）。

```bash
git add src/background/providers/adapter.ts src/background/providers/deepseek/sse-patch.ts tests/unit/sse-patch.test.ts
git commit -m "feat(parser): resume snapshot trim + strict terminal"
```

---

## Task 2: Adapter — continue 端点

**Files:**
- Modify: `src/background/providers/adapter.ts`（interface 加可选方法）
- Modify: `src/background/providers/deepseek/client.ts`
- Modify: `src/background/providers/deepseek/adapter.ts`
- Test: `tests/unit/deepseek-adapter.test.ts`

**Interfaces:**
- Consumes: `ContinueSkip`（Task 1）、`completionEvents(body, timeoutMs, onReady, skip)`（Task 1）、`baseHeaders`
- Produces: `continuePayload(session, messageId)`、`continueHeaders(token)`、`provider.continueStream(ctx, session, messageId, skip)`

- [ ] **Step 1: 写失败测试（deepseek-adapter.test.ts 末尾追加）**

import 追加：`import { continuePayload, continueHeaders } from '../../src/background/providers/deepseek/client';` 与类型 `ProviderStreamEvent`。

```ts
// 2026-09-12（feat/continue-on-incomplete）：续接端点（spec §3.2/§2 F2）。
describe('continueStream（feat/continue-on-incomplete）', () => {
  it('continuePayload/continueHeaders：实测形状、无 PoW', () => {
    const p = continuePayload({ providerId: 'deepseek', webSessionId: 's1', parentMessageId: 3 } as any, 4);
    expect(p).toEqual({ chat_session_id: 's1', message_id: 4, fallback_to_resume: true });
    const h = continueHeaders('tok');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['x-client-version']).toBe('2.4.0');
    expect(h['X-Ds-Pow-Response']).toBeUndefined();   // continue 不要求 PoW
  });

  it('fail-to-pass: continueStream 请求 /chat/continue、不调 PoW、SSE 事件接线', async () => {
    let path = '';
    let sent: Record<string, string> = {};
    const sse = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"hi"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const a = createDeepSeekAdapter(mkDeps({
      fetchStream: vi.fn(async (p: string, h: Record<string, string>) => {
        path = p; sent = h;
        return {
          status: 200, headers: new Headers(),
          body: (async function* () { yield new TextEncoder().encode(sse); })() as unknown as AsyncIterable<Uint8Array>,
        };
      }),
      // pow 被调用即抛 —— continue 路径不得触碰 PoW
      pow: { getChallenge: vi.fn(async () => { throw new Error('continue must not call pow'); }), solve: vi.fn() } as any,
    }));
    const evs: ProviderStreamEvent[] = [];
    for await (const ev of a.continueStream!(
      { token: 'tok', requestId: 'r' },
      { providerId: 'deepseek', webSessionId: 's1', parentMessageId: 3 } as any,
      4,
      { thinkingChars: 0, responseChars: 0 },
    )) evs.push(ev);
    expect(path).toBe('/chat/continue');               // 无双前缀
    expect(sent['X-Ds-Pow-Response']).toBeUndefined();
    expect(evs.some((e) => e.kind === 'message_id' && e.id === 4)).toBe(true);
    expect(evs.some((e) => e.kind === 'content_delta' && e.content === 'hi')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test tests/unit/deepseek-adapter.test.ts`
Expected: FAIL（`continuePayload` 未导出 → TypeError；`a.continueStream` undefined）。

- [ ] **Step 3: 实现 client.ts helpers**

在 `client.ts` 的 `baseHeaders` 附近新增：

```ts
/** 2026-09-12（feat/continue-on-incomplete）：续接请求体（spec §3.2 / §2 F2 实测）。
 *  POST /api/v0/chat/continue {chat_session_id, message_id, fallback_to_resume:true}——
 *  无 prompt / model_type / parent_message_id；服务端按 message_id 找回生成状态。 */
export function continuePayload(session: ProviderSession, messageId: number | string): Record<string, unknown> {
  return { chat_session_id: session.webSessionId, message_id: messageId, fallback_to_resume: true };
}

/** completion 与 continue 共用的 x-client 指纹头（**不含 PoW**——continue 端点不要求）。
 *  2026-09-12（feat/continue-on-incomplete）：自 adapter.withPowHeaders 拆出。 */
export function continueHeaders(token: string): Record<string, string> {
  return {
    ...baseHeaders(token),
    'x-client-version': '2.4.0',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': '28800',
  };
}
```

- [ ] **Step 4: 加接口方法（providers/adapter.ts）**

`ProviderAdapter` 的 `streamCompletion` 之后：

```ts
  // 2026-09-12（feat/continue-on-incomplete）：断流自动续接（spec §3.2）。可选方法（与
  // uploadFile/pollFileReady 同例）——未实现的 provider 不参与续接（router 检查存在性）。
  continueStream?(ctx: ProviderContext, session: ProviderSession, messageId: number | string, skip: ContinueSkip): AsyncIterable<ProviderStreamEvent>;
```

- [ ] **Step 5: 实现 adapter：continueStream + withPowHeaders 复用**

`client.ts` import 追加 `continuePayload, continueHeaders`；`sse-patch.ts` import 加 `fallback_to_resume` 不需要——改 import 行：

```ts
import { completionPayload, baseHeaders, classify, MODELS, resolveModel, continuePayload, continueHeaders } from './client';
```

`withPowHeaders` 返回头改为复用（保留原注释块，PoW 行保留）：

```ts
    return {
      ...continueHeaders(ctx.token),
      'X-Ds-Pow-Response': header,
    };
```

在返回对象的 `streamCompletion` 之后新增：

```ts
    // 2026-09-12（feat/continue-on-incomplete）：续接断流生成（spec §3.2 实测）。
    // POST /chat/continue（相对路径——sw.ts 拼 base；**不带 /api/v0 前缀**，FILE_FETCH_PATH 双前缀事故史）；
    // 无 PoW；响应流与 completion 同构，复用 completionEvents + skip 裁剪。
    async *continueStream(ctx, session, messageId, skip) {
      const res = await fetchStreamSafe('/chat/continue', continueHeaders(ctx.token), continuePayload(session, messageId));
      if (res.status !== 200) {
        throw classifyErr(Object.assign(new Error(`continue http ${res.status}`), { status: res.status, headers: res.headers }));
      }
      for await (const ev of completionEvents(res.body, NO_PROGRESS_MS, () => {}, { ...skip, expectMessageId: messageId })) yield ev;
    },
```

（`ContinueSkip` 类型经 `provider.continueStream?` 接口签名约束，实现处可省显式标注。）

- [ ] **Step 6: 跑测试确认通过 + 全量**

Run: `bun run test tests/unit/deepseek-adapter.test.ts && bun run test && bunx tsc --noEmit`
Expected: 全绿（既有 expert 头测试需仍通过——x-client-* 值未变）。

- [ ] **Step 7: 提交**

```bash
git add src/background/providers/adapter.ts src/background/providers/deepseek/client.ts src/background/providers/deepseek/adapter.ts tests/unit/deepseek-adapter.test.ts
git commit -m "feat(adapter): /chat/continue endpoint, no PoW"
```

---

## Task 3: Router — 锁内续接循环 + 诊断

**Files:**
- Modify: `src/background/router.ts`
- Modify: `src/background/log.ts`
- Modify: `src/popup/snippet.ts`
- Test: `tests/integration/router.test.ts`

**Interfaces:**
- Consumes: `provider.continueStream`（Task 2）、`completionEvents(..., skip)`（Task 1）、`ContinueSkip`
- Produces: `RunState` 字段、`RESUMABLE_REASONS`/`MAX_CONTINUE_ATTEMPTS`/`CONTINUE_DELAY_MS`、`LogEntry.continueAttempts`

- [ ] **Step 1: 写集成测试（router.test.ts 末尾追加）**

import 追加：`import { completionEvents } from '../../src/background/providers/deepseek/sse-patch';`

```ts
// 2026-09-12（feat/continue-on-incomplete）：断流自动续接（spec §3.1/§3.3/§3.4）。
// 续接段用**真实 parser**（completionEvents）消费自洽合成 SSE——裁剪/终态都在被测路径上。
describe('断流自动续接（feat/continue-on-incomplete）', () => {
  const sseOf = (text: string) => (async function* () { yield new TextEncoder().encode(text); })();

  it('fail-to-pass：断流 → 续接（真实 parser）→ 单次成功、无重复', async () => {
    const resumeSse = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":2,"type":"THINK","content":"想"},{"id":3,"type":"RESPONSE","content":"ab"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"cd"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const calls: Array<{ messageId: unknown; skip: { thinkingChars: number; responseChars: number } }> = [];
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'think_delta', content: '想' };
        yield { kind: 'content_delta', content: 'ab' };
        yield { kind: 'stream_stats', bytes: 100, paths: ['ready'], statusValues: ['INCOMPLETE'] };
        yield { kind: 'stream_error', message: 'Server is temporarily unavailable.', reason: 'generation_err' };
      },
      continueStream: async function* (_ctx, _session, messageId, skip) {
        calls.push({ messageId, skip: { thinkingChars: skip.thinkingChars, responseChars: skip.responseChars } });
        yield* completionEvents(sseOf(resumeSse) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(res.choices[0].message.content).toBe('abcd');          // 'ab' + 快照裁掉 + 'cd'
    expect(res.choices[0].message.reasoning_content).toBe('想');
    expect(calls).toHaveLength(1);
    expect(calls[0].messageId).toBe(4);
    expect(calls[0].skip).toEqual({ thinkingChars: 1, responseChars: 2 });
    const e: any = r['d'].log.list().at(-1)!;
    expect(e.continueAttempts).toBe(1);
    expect(e.sseStatusValues).toEqual(['INCOMPLETE', 'FINISHED']);   // 按段拼接
  });

  it('连续两次断流 → 两次续接成功（attempts=2）', async () => {
    const cont1 = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":3,"type":"RESPONSE","content":"ab"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"cd"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"INCOMPLETE"}\n\n',
      'data: {"type":"error","content":"Server is temporarily unavailable.","finish_reason":"generation_err"}\n\n',
    ].join('');
    const cont2 = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":3,"type":"RESPONSE","content":"abcd"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"ef"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const calls: any[] = [];
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'ab' };
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        calls.push({ messageId, skip: { ...skip } });
        yield* completionEvents(sseOf(calls.length === 1 ? cont1 : cont2) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(res.choices[0].message.content).toBe('abcdef');
    expect(calls).toHaveLength(2);
    expect(calls[1].skip.responseChars).toBe(4);                    // 'ab' + 'cd'
    expect((r['d'].log.list().at(-1) as any).continueAttempts).toBe(2);
  });

  it('三次续接仍断流 → 503（上限收敛）', async () => {
    const bad = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"p":"response/status","o":"SET","v":"INCOMPLETE"}\n\n',
    ].join('');
    const calls: any[] = [];
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'ab' };
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        calls.push({ messageId, skip });
        yield* completionEvents(sseOf(bad) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] }))
      .rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
    expect(calls).toHaveLength(3);
  });

  it('unsupported_client_by_model → 不调 continueStream，直接 503', async () => {
    let called = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'stream_error', message: 'Update to the latest version to use Expert.', reason: 'unsupported_client_by_model' };
      },
      continueStream: async function* () { called += 1; yield { kind: 'content_delta', content: 'x', finish_reason: 'stop' }; },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] }))
      .rejects.toMatchObject({ status: 503 });
    expect(called).toBe(0);
  });

  it('stream:true 路径：续接成功、分块连续、正常 finish', async () => {
    const resumeSse = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":3,"type":"RESPONSE","content":"ab"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"cd"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'ab' };
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        yield* completionEvents(sseOf(resumeSse) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')], stream: true });
    const chunks: any[] = [];
    for await (const c of s as AsyncIterable<any>) chunks.push(c);
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
    expect(content).toBe('abcd');
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop');
  });

  it('回归：正常流零续接；单段日志取证字段不变', async () => {
    let called = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 1 };
        yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' };
        yield { kind: 'stream_stats', bytes: 42, paths: ['ready'], rawSample: 'RS', rawTail: 'RT', autoResume: false, hasPendingFragment: true, statusValues: ['FINISHED'] };
      },
      continueStream: async function* () { called += 1; yield { kind: 'content_delta', content: 'x', finish_reason: 'stop' }; },
    });
    const r = makeRouter(a);
    await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    expect(called).toBe(0);
    const e: any = r['d'].log.list().at(-1)!;
    expect(e.sseRaw).toBe('RS');
    expect(e.sseRawTail).toBe('RT');
    expect(e.sseAutoResume).toBe(false);
    expect(e.sseHasPendingFragment).toBe(true);
    expect(e.continueAttempts).toBe(0);
  });

  it('DSML 跨段对齐：skip 用原始字符数（含归一化器扣住的尾部）', async () => {
    const TOOL2 = [{ type: 'function' as const, function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } } }];
    const cont = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\n',
      'data: {"v":{"response":{"message_id":4,"fragments":[{"id":3,"type":"RESPONSE","content":"ab<"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"x"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const calls: any[] = [];
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'ab<' };   // 归一化器 emit 'ab'、扣住 '<'
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        calls.push({ skip: { ...skip } });
        yield* completionEvents(sseOf(cont) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    const s = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')], tools: TOOL2, stream: true });
    const chunks: any[] = [];
    for await (const c of s as AsyncIterable<any>) chunks.push(c);
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
    expect(calls[0].skip.responseChars).toBe(3);   // 原始数（可见数只有 2）
    expect(content).toBe('ab<x');                  // 缓冲 '<' + 'x' 对齐，无重复 '<'
  });

  it('未拿到 message_id（ready 前断流）→ 不续接，直接 503', async () => {
    let called = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* () { called += 1; yield { kind: 'content_delta', content: 'x', finish_reason: 'stop' }; },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] }))
      .rejects.toMatchObject({ status: 503 });
    expect(called).toBe(0);
  });

  it('fallback 换 message：计数按 message 清零，skip 基线不跨 message', async () => {
    const cont1 = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":5}\n\n',   // fallback：id 5 ≠ 4
      'data: {"v":{"response":{"message_id":5,"fragments":[{"id":2,"type":"RESPONSE","content":"AB"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"CD"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"INCOMPLETE"}\n\n',
      'data: {"type":"error","content":"boom","finish_reason":"generation_err"}\n\n',
    ].join('');
    const cont2 = [
      'event: ready\ndata: {"request_message_id":3,"response_message_id":5}\n\n',
      'data: {"v":{"response":{"message_id":5,"fragments":[{"id":2,"type":"RESPONSE","content":"ABCDEF"}]}}}\n\n',   // 4 已发 + EF 未送达
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"GH"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const calls: any[] = [];
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'P' };
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        calls.push({ messageId, skip: { ...skip } });
        yield* completionEvents(sseOf(calls.length === 1 ? cont1 : cont2) as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    const res: any = await r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] });
    // seg1 'P' + cont1 'AB'+'CD'（id 不匹配 → 不裁剪） + cont2 裁掉 'ABCD' 后发 'EF' + append 'GH'
    expect(res.choices[0].message.content).toBe('PABCDEFGH');
    expect(calls).toHaveLength(2);
    expect(calls[0].messageId).toBe(4);
    expect(calls[1].messageId).toBe(5);                                        // 换 message 后指向新 id
    expect(calls[1].skip).toEqual({ thinkingChars: 0, responseChars: 4 });     // 漏清零会是 5 → 吞掉 'E'
  });

  it('续接返回 200 空流 → 计失败，上限后 503（不假成功）', async () => {
    let calls = 0;
    const a = stubAdapter({
      streamCompletion: async function* () {
        yield { kind: 'message_id', id: 4 };
        yield { kind: 'content_delta', content: 'ab' };
        yield { kind: 'stream_error', message: 'boom', reason: 'generation_err' };
      },
      continueStream: async function* (_c, _s, messageId, skip) {
        calls += 1;
        const empty = (async function* () {})();
        yield* completionEvents(empty as AsyncIterable<Uint8Array>, 1000, () => {}, { ...skip, expectMessageId: messageId });
      },
    });
    const r = makeRouter(a);
    await expect(r.create(TOKEN, { model: 'deepseek-v4-flash', messages: [m('user', 'hi')] }))
      .rejects.toMatchObject({ status: 503, error: { error: { code: 'provider_unavailable' } } });
    expect(calls).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test tests/integration/router.test.ts`
Expected: 续接相关用例 FAIL（无续接循环 → 直接 503 或断言不符）；回归用例通过。

- [ ] **Step 3: LogEntry + Forensics（log.ts / snippet.ts）**

`src/background/log.ts` 的 `sseAutoResume` 字段附近：

```ts
  // 2026-09-12（feat/continue-on-incomplete）：本次请求实际续接次数（0 = 未续接）。
  continueAttempts?: number;
```

`src/popup/snippet.ts` 的 `FORENSIC_FIELDS`：`'sseAutoResume', 'sseHasPendingFragment',` 之后加 `'continueAttempts',`。

- [ ] **Step 4: Router 常量 + RunState（router.ts）**

`NO_PROGRESS_MS` 附近的常量区：

```ts
// 2026-09-12（feat/continue-on-incomplete）：断流续接（spec §3.4）——上限 3 次、间隔 500ms；
// 仅这两类是「可恢复断流」（generation_err 实测网页给 Continue 按钮；incomplete_status 是
// parser 对非 FINISHED 终态/无终态的合成原因）。
const MAX_CONTINUE_ATTEMPTS = 3;
const CONTINUE_DELAY_MS = 500;
const RESUMABLE_REASONS = new Set(['generation_err', 'incomplete_status']);
```

`RunState` 接口追加：

```ts
  // 2026-09-12（feat/continue-on-incomplete）：续接计数 + per-message 原始字符数（skip 基线，spec §3.3）。
  continueAttempts: number;
  emittedThinkChars: number;
  emittedContentChars: number;
```

`runCompletion` 内 `const run: RunState = { parentMessageId: null, repairDone: false, model: resolved, promptLen: prompt.length };` 改为：

```ts
    const run: RunState = { parentMessageId: null, repairDone: false, model: resolved, promptLen: prompt.length, continueAttempts: 0, emittedThinkChars: 0, emittedContentChars: 0 };
```

`handle.stream = this.runExclusiveStream(provider, ctx, req, async () => {` 改为传入 `run`：

```ts
    handle.stream = this.runExclusiveStream(provider, ctx, req, run, async () => {
```

- [ ] **Step 5: runExclusiveStream 重写（wrapper）**

签名加 `run`：

```ts
  private runExclusiveStream(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion, run: RunState, afterLock?: () => Promise<void>): AsyncIterable<ProviderStreamEvent> {
```

生成器体内，`for await (const ev of src) yield ev;` 替换为：

```ts
        // 2026-09-12（feat/continue-on-incomplete）：续接 wrapper（spec §3.3/§3.4）——单点完成
        // per-message 原始字符计数（skip 基线）与 stream_stats 全程累计改写；消费侧零改动。
        let currentMessageId: number | string | null = run.parentMessageId;
        let statBytes = 0;
        let statThink = 0;
        let statResp = 0;
        let statRawSample: string | undefined;
        let statRawTail: string | undefined;
        let statAutoResume: boolean | undefined;
        let statPending: boolean | undefined;
        const statPaths = new Set<string>();
        const statStatus: string[] = [];
        const intercept = (ev: ProviderStreamEvent): ProviderStreamEvent => {
          if (ev.kind === 'message_id') {
            if (String(ev.id) !== String(currentMessageId)) {
              currentMessageId = ev.id;
              run.emittedThinkChars = 0;      // fallback 换 message → skip 基线清零（spec §3.3）
              run.emittedContentChars = 0;
            }
          } else if (ev.kind === 'think_delta') {
            run.emittedThinkChars += ev.content.length;
          } else if (ev.kind === 'content_delta') {
            run.emittedContentChars += ev.content.length;
          } else if (ev.kind === 'stream_stats') {
            statBytes += ev.bytes;
            for (const p of ev.paths) statPaths.add(p);
            if (ev.statusValues) statStatus.push(...ev.statusValues);
            statThink += ev.thinkingChars ?? 0;
            statResp += ev.responseChars ?? 0;
            if (statRawSample === undefined && ev.rawSample) statRawSample = ev.rawSample;
            if (ev.rawTail) statRawTail = ev.rawTail;
            if (ev.autoResume !== undefined) statAutoResume = ev.autoResume;
            if (ev.hasPendingFragment !== undefined) statPending = ev.hasPendingFragment;
            return { ...ev, bytes: statBytes, paths: [...statPaths], statusValues: [...statStatus], thinkingChars: statThink, responseChars: statResp, rawSample: statRawSample, rawTail: statRawTail, autoResume: statAutoResume, hasPendingFragment: statPending };
          }
          return ev;
        };
        const segment = async function* (source: AsyncIterable<ProviderStreamEvent>) {
          for await (const ev of source) yield intercept(ev);
        };
        yield* segment(src);
        // 续接循环：锁仍持有（spec §3.4）；条件 = 可续原因 + 有 message id + 未超上限 + adapter 支持。
        // 先取到局部常量——TS 不在调用处保留 property narrowing（await 后失效）。
        const cont = provider.continueStream;
        while (
          run.streamError !== undefined &&
          RESUMABLE_REASONS.has(run.streamError.reason ?? '') &&
          currentMessageId !== null &&
          run.continueAttempts < MAX_CONTINUE_ATTEMPTS &&
          cont !== undefined
        ) {
          run.streamError = undefined;
          run.continueAttempts += 1;
          await sleep(CONTINUE_DELAY_MS);
          yield* segment(cont(ctx, req.session, currentMessageId, {
            thinkingChars: run.emittedThinkChars,
            responseChars: run.emittedContentChars,
          }));
        }
```

- [ ] **Step 6: done()/LogEntry 带 continueAttempts**

`done` 的 extra 类型追加 `continueAttempts?: number`；`this.d.log.push({...})` 里 `sseHasPendingFragment: extra?.sseHasPendingFragment,` 之后加 `continueAttempts: extra?.continueAttempts,`。

4 处 `done(...)` 调用（非流式成功/失败、流式成功/失败）的 extra 末尾各加：

```ts
, continueAttempts: handle.run.continueAttempts
```

（各调用末尾是 `sseHasPendingFragment: handle.run.sseHasPendingFragment });`，改为 `sseHasPendingFragment: handle.run.sseHasPendingFragment, continueAttempts: handle.run.continueAttempts });`。）

- [ ] **Step 7: 跑测试确认通过 + 全量**

Run: `bun run test tests/integration/router.test.ts && bun run test && bunx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/background/router.ts src/background/log.ts src/popup/snippet.ts tests/integration/router.test.ts
git commit -m "feat(router): auto-continue inside queue lock"
```

---

## Task 4: 版本、构建、文档收尾

**Files:**
- Modify: `manifest.json` / `package.json`（bump 脚本自动）
- Modify: `docs/01.memory.md`
- Modify: `docs/02.todo.md`（归档完成项）

**Interfaces:**
- Consumes: 前 3 个任务的代码与测试
- Produces: 可加载的 `extension/` 构建产物（v0.2.8）

- [ ] **Step 1: bump + build + 全量测试**

```bash
bun run bump && bun run build && bun run test
```

Expected: 版本末位 +1（当前 v0.2.7 → v0.2.8）；构建通过（tsc + esbuild）；全绿。

- [ ] **Step 2: 验证构建产物含新代码**

```bash
grep -c 'continueStream' extension/sw.js
grep -o 'resume ended without terminal status' extension/sw.js | head -1
grep -o 'continueAttempts' extension/sw.js | head -1
```

Expected: 三者都有输出（非 0）。若 `extension/sw.js` 未更新 = 构建没生效（memory 的教训：加载旧代码）。

- [ ] **Step 3: memory 更新**

`docs/01.memory.md`：
- 「续接端点与响应流形态」条目：把「待实施」改为已实施（v0.2.8，`/chat/continue` + skip 裁剪 + 锁内续接循环，spec 路径）；
- 「deep.api 当前版本」行改为 v0.2.8。

- [ ] **Step 4: todo 归档**

`docs/02.todo.md` 的续接条目移入 `docs/02.todo.archive.md`（追加一节，含完成日期与版本），主文件删去该条目（保留 `# 待定任务` 标题）。

- [ ] **Step 5: 提交**

```bash
git add manifest.json package.json docs/
git commit -m "chore(release): v0.2.8 auto-continue on incomplete stream"
```

- [ ] **Step 6: 手测验收（spec §7）**

按 AGENTS.md §13 在 worktree 完成合并前，用 stub 注入或真实断流场景验证：客户端收到完整内容、无重复、无 503（spec §7.1）。真实场景不可复现时，以 Task 3 的集成用例（stub 注入断流 + 真实 parser 续接 SSE）作为验收证据，并在 memory 注明。

---

## Self-Review（已执行）

- **Spec 覆盖**：§2 事实（Task 2 单测对照 F2 形状）、§3.1 触发（Task 3 Step 5 条件）、§3.2 续接调用（Task 2）、§3.3 合并（Task 1 + Task 3 计数）、§3.4 循环/终态（Task 1 Step 8 + Task 3 Step 5）、§3.5 挂点（各 Task Files 一致）、§3.7 诊断（Task 3 Step 6 + 用例断言）、§4 全部 16 用例（Task 1: 1-6；Task 2: client/adapter；Task 3: 7-16）、§7 验收（Task 4）。无缺口。
- **占位符扫描**：无 TBD/TODO；所有测试与实现均给出完整代码。
- **类型一致性**：`ContinueSkip`（Task 1 定义 → Task 2/3 使用）；`completionEvents` 第 4 参在 Task 1/2 与测试中签名一致；`RunState` 字段名（`continueAttempts`/`emittedThinkChars`/`emittedContentChars`）在 Task 3 各处一致；`LogEntry.continueAttempts` 与 `done()` extra 名一致。
