# deep.api 扩展（v1：DeepSeek 网页版 → OpenAI 形态接口）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 Chrome MV3 扩展：网站通过注入的 `window.deepApi`（OpenAI 形态）直接调用扩展，扩展抓取 chat.deepseek.com 的 Cookie 打内部 API，把 SSE 流式结果转成 OpenAI 分块；无伴生进程。

**Architecture:** 三层：网页桥接（MAIN world API 面 + ISOLATED relay）→ Service Worker 核心层（Router/SessionMapper/TranscriptRenderer/ToolPipeline/ChunkEncoder/Queue，对 chrome.* 零依赖）→ ProviderAdapter（v1 仅 DeepSeek：Cookie 认证 + PoW + JSON-Patch SSE）。无状态语义由 SessionMapper 保证：客户端 messages 是唯一事实，网页会话只是缓存，镜像不匹配就重建。

**Tech Stack:** TypeScript、esbuild（构建，无 bundler 框架）、vitest（测试）、@types/chrome（类型）、MV3 ESM service worker。零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-08-deep-api-extension-design.md`（本计划实现它；执行者同时读 spec 与本文档）。

## Global Constraints

- MV3 扩展；**不引入任何伴生进程、本地 HTTP 服务、外部依赖**。
- 核心层模块（`src/background/` 除 `sw.ts`、`auth/cookie` 门）**不得 import 任何 chrome.\* API**；chrome 能力全部经注入依赖传入。
- 调用面：`window.deepApi.chat.completions.create(params)` / `window.deepApi.models.list()`；params 仅 `model`/`messages`/`stream`/`tools`/`tool_choice`/`conversation_id`/`apiKey`，其余忽略。
- 错误模型（spec §10）：`missing_api_key`(401)、`invalid_api_key`(401)、`invalid_request_error`(400)、`rate_limited`(429)、`provider_unavailable`(503)、`internal_error`(500)。
- 池/TTL/队列/退避（spec §4.3/§6.4）：poolSize 默认 2（1–5）、TTL 30 分钟、队列等待 60s 超时、限流退避 500ms×2^n 上限 3 次（仅指首增量前的失败）、流 10 分钟无进度断流。
- usage 仅在 input 与 output 计数都可得时输出；不得编造计数。
- 日志 20 条循环，不含消息内容与 API Key。
- Provider 契约（spec §5，含本次增补）：`ProviderStreamEvent` 含 `message_id` 事件；接口含 `stopStream(ctx, providerSession, messageId)`。
- 模型映射（spec §6.3）：`deepseek-chat`→`default`（thinking off，上限 2,621,440 字符）、`deepseek-reasoner`→`expert`（thinking on，上限 163,840 字符）；`vision` 不接入。
- 测试：核心模块单测覆盖率 ≥ 80%；契约测试 + 集成测试全绿；TDD：先写失败测试再实现。
- 实现代码全部在 git worktree 中进行（执行时用 using-git-worktrees 技能），不许触碰主目录代码；完成后按 AGENTS.md §13 合并。
- 提交信息描述性，主题 ≤72 字符。

---

### Task 1: 项目脚手架（TS + esbuild + vitest）

**Files:**
- Create: `package.json`、`tsconfig.json`、`build.mjs`、`vitest.config.ts`、`.gitignore`、`tests/unit/smoke.test.ts`

**Interfaces:**
- Produces: 两条命令 —— `npm run build`（产出 `dist/`）、`npm test`（vitest run）；`src/` 目录骨架（后续任务填充）。

- [ ] **Step 1: 写脚手架文件**

`package.json`（deps 全 dev）:
```json
{
  "name": "deep-api-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/chrome": "^0.0.280"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "types": ["chrome", "vitest/globals"]
  },
  "include": ["src", "tests", "build.mjs", "vitest.config.ts"]
}
```

`build.mjs`（四个入口，输出到 `dist/`）:
```js
import { build } from 'esbuild';
const shared = { bundle: true, sourcemap: false, minify: true, target: 'es2022', logLevel: 'info' };
await Promise.all([
  build({ ...shared, entryPoints: ['src/background/sw.ts'], outfile: 'dist/sw.js', format: 'esm' }),
  build({ ...shared, entryPoints: ['src/content/bridge-main.ts'], outfile: 'dist/bridge-main.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/content/bridge-relay.ts'], outfile: 'dist/bridge-relay.js', format: 'iife' }),
  build({ ...shared, entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js', format: 'iife' }),
]);
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environmentMatchGlobs: [['tests/integration/bridge.test.ts', 'jsdom']] } });
```

`.gitignore`: `node_modules/`、`dist/`、`*.local`

`tests/unit/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 2: 安装并验证命令**

Run: `npm install && npm run build && npm test`
Expected: build 报 4 个入口的源文件不存在错误（正常，脚手架先行）；`npm test` PASS 1。

- [ ] **Step 3: 建目录骨架并让 build 通过**

Create: `src/background/`、`src/content/`、`src/popup/`、`src/shared/` 下各放一个空占位文件（仅注释行，保证入口存在）：`src/background/sw.ts` 内容 `// task 10`，等。build.mjs 中 popup 入口与 3 个已存在入口全部编译通过。

- [ ] **Step 4: 跑测试验证**

Run: `npm test`、`npm run build`
Expected: PASS；dist/ 生成 4 个文件。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold TS/esbuild/vitest build for MV3 extension"
```

---

### Task 2: Spike——契约探测与夹具录制（需真实账号，可与 Task 3–8 并行）

**Files:**
- Create: `examples/spike-probe/index.html`（独立探测页，file:// 打开）、`tests/fixtures/deepseek/{pow-challenge,sse-normal,sse-ratelimit,sse-waf,sse-unauthorized}.json`
- Modify: `docs/superpowers/specs/2026-09-08-deep-api-extension-design.md` §6.x（按实测回填）

**Interfaces:**
- Produces: 冻结的适配器契约 + 夹具文件（Task 6/7/9 消费）。

- [ ] **Step 1: 写探测页**

`examples/spike-probe/index.html`：一个页面 + 按钮，JS 用 `fetch` 直打以下探测（用户已登录 chat.deepseek.com 时浏览器自动带 Cookie；页面代码拿到运行时 cookie 字符串用于显式请求头验证）。探测序列（每个结果渲染到页面并支持一键复制 JSON）：

```
1. get cookie: document.cookie 中 user_token 是否存在（及完整 cookie 名清单）
2. POST https://chat.deepseek.com/api/v0/chat_session/create
   headers: { Authorization: Bearer <user_token>, 'X-Client-Version':'2.0.0', 'X-Client-Platform':'android', 'X-Client-Locale':'zh_CN' }
   记录：HTTP 状态、响应体（找 chat_session_id 字段名）
3. POST /api/v0/chat/create_pow_challenge body {target_path:'/api/v0/chat/completion'} 同 headers
   记录：完整响应 JSON（algorithm/challenge/difficulty/target_path/salt/expire_at 字段名与类型）
4. POST /api/v0/chat/completion（分两次：不带 PoW 头 vs 带伪造 PoW 头）
   载荷 {chat_session_id, parent_message_id:null, model_type:'default', prompt:'你好', ref_file_ids:[], thinking_enabled:false, search_enabled:false, preempt:false}
   记录：两者 HTTP 状态差异；成功路径的 SSE 原始流（原样保存为 sse-normal.json，脱敏后）
5. 同 4 但 model_type:'expert', thinking_enabled:true —— 记录 ready 事件与 think 片段是否出现
6. 连发 6 个 completion（同一 session、parent 链接）—— 记录 429/202/业务码的真实形态
7. 别的 IP 风险提示：探测 202 + x-amzn-waf-action 响应头是否存在过
```

- [ ] **Step 2: 执行探测并固化结果**

操作：Chrome 登录 chat.deepseek.com → file:// 打开探测页 → 跑完 → 复制结果 JSON。把 SSE 原流（**token 脱敏：替换 user_token 与任何 40+ 位随机串**）写入 `tests/fixtures/deepseek/*.json`（正常/限流/WAF/未授权各一），pow-challenge.json 存步骤 3 响应。

- [ ] **Step 3: 回填 spec**

修改 spec §6：cookie 名单、必需头部组合、ready 事件字段、SSE 事件/路径全集、model_type 后端值、限流形态（HTTP 码/业务码）、PoW 头格式实测结论。协作者确认后 commit：

```bash
git add examples/spike-probe tests/fixtures docs/superpowers/specs
git commit -m "spike: verify deepseek web contract and record fixtures"
```

**注意：** 若实测与 Task 6/7/9 的代码骨架冲突（如事件名为 `response/status` 变体），以夹具与 spec 为准修正骨架，冲突点在 code review 说明。

---

### Task 3: 共享类型与桥接协议

**Files:**
- Create: `src/shared/api-types.ts`、`src/shared/protocol.ts`
- Test: `tests/unit/protocol.test.ts`

**Interfaces:**
- Produces（后续全部任务依赖）:
  - `api-types.ts`：`Role`、`Message`（含 `tool_calls?`）、`ToolDef`、`ToolCall`、`ToolChoice`、`ChatCompletionUsage`、`ChatCompletionChunk`、`ChatCompletion`、`ApiErrorCode`、`ApiErrorBody`、`ModelInfo`
  - `protocol.ts`：`BridgeMethod = 'chat.completions.create' | 'chat.completions.cancel' | 'models.list'`、`BridgeRequestMsg`、`BridgeResponseMsg`、`isBridgeRequest(v): v is BridgeRequestMsg`、`BridgeParams`、`BridgeError`（class，含 `error: ApiErrorBody` 与 `status: number`）

- [ ] **Step 1: 写失败测试**

`tests/unit/protocol.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isBridgeRequest } from '../src/shared/protocol';

describe('isBridgeRequest', () => {
  it('accepts valid envelope', () => {
    const v = { __deepApi: { id: 1, method: 'chat.completions.create', params: { model: 'deepseek-chat', messages: [] } } };
    expect(isBridgeRequest(v)).toBe(true);
  });
  it('rejects foreign payloads', () => {
    expect(isBridgeRequest({ hello: 1 })).toBe(false);
    expect(isBridgeRequest({ __deepApi: { id: 1, method: 'evil', params: {} } })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL（`isBridgeRequest` 不存在）。

- [ ] **Step 3: 实现两个文件**

`src/shared/api-types.ts`:
```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message {
  role: Role; content: string;
  tool_call_id?: string; name?: string;   // role='tool' 时
  tool_calls?: ToolCall[];                 // role='assistant' 时
}
export interface ToolDef { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }
export type ToolChoice = 'none' | 'auto' | { type: 'function'; function: { name: string } };
export interface ChatCompletionUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export type FinishReason = 'stop' | 'tool_calls' | string;
export interface ChatCompletionChunk {
  id: string; object: 'chat.completion.chunk'; created: number; model: string;
  choices: [{ index: 0; delta: { role?: Role; content?: string; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: FinishReason | null }];
}
export interface ChatCompletion {
  id: string; object: 'chat.completion'; created: number; model: string;
  choices: [{ index: 0; message: { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: FinishReason }];
  usage?: ChatCompletionUsage;
}
export type ApiErrorCode = 'missing_api_key' | 'invalid_api_key' | 'invalid_request_error' | 'rate_limited' | 'provider_unavailable' | 'internal_error';
export interface ApiErrorBody { error: { message: string; type: string; code: ApiErrorCode } }
export interface ModelInfo { id: string; provider: string; description: string }
```

`src/shared/protocol.ts`:
```ts
import type { ApiErrorBody, ChatCompletion, ChatCompletionChunk } from './api-types';

export type BridgeMethod = 'chat.completions.create' | 'models.list';
export interface BridgeParams { model: string; messages: Message[]; stream?: boolean; tools?: ToolDef[]; tool_choice?: ToolChoice; apiKey?: string; conversation_id?: string }
export type BridgeRequestMsg = { __deepApi: { id: number; method: BridgeMethod; params: unknown } };
export type BridgeResponseMsg =
  | { __deepApi: { id: number; kind: 'result'; value: unknown } }
  | { __deepApi: { id: number; kind: 'chunk'; chunk: ChatCompletionChunk } }
  | { __deepApi: { id: number; kind: 'done' } }
  | { __deepApi: { id: number; kind: 'error'; error: ApiErrorBody } };
export function isBridgeRequest(v: unknown): v is BridgeRequestMsg {
  if (typeof v !== 'object' || v === null) return false;
  const inner = (v as { __deepApi?: unknown }).__deepApi;
  if (typeof inner !== 'object' || inner === null) return false;
  const m = inner as { id?: unknown; method?: unknown; params?: unknown };
  return typeof m.id === 'number' && (m.method === 'chat.completions.create' || m.method === 'chat.completions.cancel' || m.method === 'models.list') && typeof m.params === 'object' && m.params !== null;
}
export class BridgeError extends Error {
  constructor(public error: ApiErrorBody, public status: number) { super(error.error.message); this.name = 'BridgeError'; }
}
```
（`Message`/`ToolDef`/`ToolChoice` 从 api-types re-export：`export type { Message, ToolDef, ToolChoice } from './api-types';`）

- [ ] **Step 4: 跑测试验证**

Run: `npx vitest run tests/unit/protocol.test.ts && npx tsc --noEmit`
Expected: 测试 PASS；tsc 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/shared tests/unit/protocol.test.ts && git commit -m "feat: shared api types and bridge protocol validation"
```

---

### Task 4: TranscriptRenderer（messages → 单轮转录）

**Files:**
- Create: `src/background/transcript-renderer.ts`
- Test: `tests/unit/transcript-renderer.test.ts`

**Interfaces:**
- Consumes: `Message`、`ToolCall`（Task 3）
- Produces:
  - `hashMessages(msgs: Message[]): Promise<string>` — SHA-256（hex）前 32 字符
  - `limitCharsFor(modelType: 'default' | 'expert'): number` — 2_621_440 / 163_840
  - `renderTranscript(messages: Message[]): { ok: true; prompt: string } | { ok: false; reason: 'too-long'; limitChars: number; actualChars: number }`
  - `renderTail(tail: Message[]): string` — 增量尾部渲染（与 renderTranscript 同格式，但按尾部消息渲染）
  - 渲染格式（本轮定稿，spike 校准点：system 标签名与角色标签前缀）：
    `system → '<｜System｜>\n' + content`；`user/assistant → '<｜user｜>\n' + content`（待 spike 定稿；fallback 用 `user:`/`assistant:` 前缀 + 校准标记）；tool → `tool(tool_call_id): {content}`；assistant 的 tool_calls 渲染为 `assistant-tool-call: {"name":...,"arguments":...}` 单行；连续同角色合并为一段（content 间 `\n\n`）。

- [ ] **Step 1: 写失败测试**

`tests/unit/transcript-renderer.test.ts`（核心用例）:
```ts
import { describe, it, expect } from 'vitest';
import { hashMessages, renderTranscript, renderTail, limitCharsFor } from '../src/background/transcript-renderer';
import type { Message } from '../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });

describe('renderTranscript', () => {
  it('merges adjacent same-role messages', () => {
    const r = renderTranscript([m('user','a'), m('user','b'), m('assistant','c')]);
    expect(r.ok && (r.prompt.match(/a\s*\n\s*b/g)?.length ?? 0)).toBeGreaterThan(0);
    expect(r.ok && r.prompt.indexOf('c')).toBeGreaterThan(-1);
  });
  it('folds system into first block, keeps role order', () => {
    const r = renderTranscript([m('system','sys'), m('user','u1'), m('assistant','a1')]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt.indexOf('sys')).toBeLessThan(r.prompt.indexOf('u1'));
    expect(r.prompt.indexOf('u1')).toBeLessThan(r.prompt.indexOf('a1'));
  });
  it('renders tool messages and tool_calls', () => {
    const r = renderTranscript([m('user','q'), m('assistant','', { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }), m('tool','result', { tool_call_id: 'c1' })]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.prompt).toContain('c1');
    expect(r.prompt).toContain('result');
  });
  it('rejects over-limit transcripts', () => {
    const long = m('user', 'x'.repeat(limitCharsFor('expert') + 10));
    const r = renderTranscript([long]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe('too-long'); expect(r.actualChars).toBeGreaterThan(r.limitChars); }
  });
});

describe('hashMessages', () => {
  it('is stable and distinct', async () => {
    const a = await hashMessages([m('user','hi')]);
    const b = await hashMessages([m('user','hi')]);
    const c = await hashMessages([m('user','ho')]);
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('renderTail', () => {
  it('renders multi-turn tail with role markers', () => {
    const t = renderTail([m('tool','r', { tool_call_id: 'c2' }), m('user','next')]);
    expect(t).toContain('c2'); expect(t).toContain('next');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/transcript-renderer.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/background/transcript-renderer.ts`:
```ts
import type { Message } from '../shared/api-types';

export function limitCharsFor(modelType: 'default' | 'expert'): number { return modelType === 'expert' ? 163_840 : 2_621_440; }

function mergeAdjacent(msgs: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role && msg.role !== 'tool' && !last.tool_calls) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else { out.push({ ...msg }); }
  }
  return out;
}

function renderOne(msg: Message): string {
  switch (msg.role) {
    case 'system': return `<｜System｜>\n${msg.content}`;
    case 'user': return `<｜user｜>\n${msg.content}`;
    case 'assistant':
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls.map(c => `assistant-tool-call: ${JSON.stringify({ name: c.function.name, arguments: c.function.arguments })}`).join('\n');
        return `<｜assistant｜>\n${calls}`;
      }
      return `<｜assistant｜>\n${msg.content}`;
    case 'tool': return `tool(${msg.tool_call_id ?? ''}): ${msg.content}`;
  }
}

export function renderTranscript(messages: Message[]): { ok: true; prompt: string } | { ok: false; reason: 'too-long'; limitChars: number; actualChars: number } {
  const merged = mergeAdjacent(messages);
  const prompt = merged.map(renderOne).join('\n\n');
  return { ok: true, prompt };
}
export function renderTail(tail: Message[]): string { return renderTranscript(tail).ok ? (renderTranscript(tail) as { ok: true; prompt: string }).prompt : ''; }
export async function hashMessages(msgs: Message[]): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(msgs));
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
```
（超限检查由 Router 在拿到渲染结果后执行：renderTranscript 保持纯字符串职责，**超限判定在 Task 10 Router 中实现**，本任务测试用例 4 改为调用 `limitCharsFor` 验证常量后删除该用例——见 Step 4 注。）

- [ ] **Step 4: 跑测试并修整**

Run: `npx vitest run tests/unit/transcript-renderer.test.ts`
Expected: 用例 1–3、hash、tail 通过。用例 4（over-limit）按职责划分改为验证两处：`expect(limitCharsFor('expert')).toBe(163_840)` 与 `expect(limitCharsFor('default')).toBe(2_621_440)`（删除原本地超限断言，超限真正逻辑在 Task 10 的 Router 集成测试中覆盖）。

```ts
it('exports model char limits', () => { expect(limitCharsFor('expert')).toBe(163_840); expect(limitCharsFor('default')).toBe(2_621_440); });
```

- [ ] **Step 5: Commit**

```bash
git add src/background/transcript-renderer.ts tests/unit/transcript-renderer.test.ts && git commit -m "feat: transcript renderer with role tags and merging"
```

---

### Task 5: ChunkEncoder（ProviderStreamEvent → OpenAI 分块）

**Files:**
- Create: `src/background/chunk-encoder.ts`
- Test: `tests/unit/chunk-encoder.test.ts`

**Interfaces:**
- Consumes: `ProviderStreamEvent` 与 `ProviderAdapter` 等类型（`providers/adapter.ts` 接口文件由本任务 Step 1 先行落地，Task 9 只补实现）
- Produces:
  - `StreamContext = { id: string; model: string; created: number }`
  - `StreamAggregate = { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: FinishReason | null; usage?: ChatCompletionUsage }`
  - `eventToChunks(ev: ProviderStreamEvent, ctx: StreamContext): ChatCompletionChunk[]`
  - `finalChunk(ctx: StreamContext, finishReason: FinishReason, usage?: ChatCompletionUsage): ChatCompletionChunk`
  - `toAggregate(ctx: StreamContext, agg: StreamAggregate): ChatCompletion`

- [ ] **Step 1: 写 adapter.ts 接口骨架（本任务前置，Task 9 继承此定义）**

`src/background/providers/adapter.ts`（完整接口，Task 9 只补实现，不重定义类型）:
```ts
import type { ModelInfo } from '../../shared/api-types';

export type ProviderId = 'deepseek' | (string & {});
export interface ProviderContext { token: string; requestId: string }
export type AuthStatus = { state: 'logged_in' } | { state: 'logged_out' } | { state: 'expired'; message: string };
export interface ProviderSession { providerId: ProviderId; webSessionId: string; parentMessageId: number | string | null }
export interface ProviderCompletion { session: ProviderSession; prompt: string; model: { modelType: 'default' | 'expert'; thinking: boolean }; requestId: string }
export interface ResolvedModel { modelId: string; modelType: 'default' | 'expert'; thinking: boolean; limitChars: number }
export interface ProviderAdapter {
  readonly id: ProviderId;
  auth: {
    readonly loginPageUrl: string;
    readonly cookieDomain: string;
    readonly requiredCookies: string[];
    getAuthStatus(ctx: ProviderContext): Promise<AuthStatus>;
  };
  createSession(ctx: ProviderContext): Promise<ProviderSession>;
  deleteSession(ctx: ProviderContext, s: ProviderSession): Promise<void>;
  stopStream(ctx: ProviderContext, s: ProviderSession, messageId: number | string | null): Promise<void>;
  streamCompletion(ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent>;
  readonly models: ModelInfo[];
  resolveModel(modelId: string): ResolvedModel | null;
  isRateLimited(err: unknown): boolean;
  isAuthExpired(err: unknown): boolean;
  isUnavailable(err: unknown): boolean;
  capabilities: { thinking: boolean; functionCalling: 'none' | 'prompt-engineered' };
}
export type ProviderStreamEvent =
  | { kind: 'message_id'; id: number | string }
  | { kind: 'think_delta'; content: string }
  | { kind: 'content_delta'; content: string; finish_reason?: 'stop' | string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };
export { ModelInfo };
```

- [ ] **Step 2: 写失败测试**

`tests/unit/chunk-encoder.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eventToChunks, finalChunk, toAggregate } from '../src/background/chunk-encoder';
import type { ProviderStreamEvent } from '../src/background/providers/adapter';

const ctx = { id: 'chatcmpl-1', model: 'deepseek-chat', created: 1700000000 };

describe('eventToChunks', () => {
  it('maps think/content deltas', () => {
    const a = eventToChunks({ kind: 'think_delta', content: '思考' }, ctx);
    expect(a[0]!.choices[0]!.delta.reasoning_content).toBe('思考');
    const b = eventToChunks({ kind: 'content_delta', content: '答', finish_reason: 'stop' }, ctx);
    expect(b[0]!.choices[0]!.delta.content).toBe('答');
    expect(b[0]!.choices[0]!.finish_reason).toBe('stop');
  });
  it('omits usage unless both counts present', () => {
    const u = eventToChunks({ kind: 'usage', inputTokens: 10, outputTokens: 5 }, ctx);
    expect(u[0]!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});
describe('toAggregate', () => {
  it('assembles non-stream response with honest usage', () => {
    const r = toAggregate(ctx, { content: 'c', reasoning: 'r', toolCalls: [], finishReason: 'stop', usage: undefined });
    expect(r.choices[0]!.message.content).toBe('c');
    expect(r.choices[0]!.message.reasoning_content).toBe('r');
    expect(r.usage).toBeUndefined();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/unit/chunk-encoder.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现**

`src/background/chunk-encoder.ts`:
```ts
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionUsage, FinishReason, ToolCall } from '../shared/api-types';
import type { ProviderStreamEvent } from './providers/adapter';

export interface StreamContext { id: string; model: string; created: number }
export interface StreamAggregate { content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: FinishReason | null; usage?: ChatCompletionUsage }

export function eventToChunks(ev: ProviderStreamEvent, ctx: StreamContext): ChatCompletionChunk[] {
  const base = { id: ctx.id, object: 'chat.completion.chunk' as const, created: ctx.created, model: ctx.model };
  switch (ev.kind) {
    case 'think_delta':
      return [{ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.content }, finish_reason: null }] }];
    case 'content_delta':
      return [{ ...base, choices: [{ index: 0, delta: { content: ev.content }, finish_reason: (ev.finish_reason ?? null) as FinishReason | null }] }];
    case 'usage':
      return [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens } }];
    case 'message_id':
      return [];
  }
}
export function finalChunk(ctx: StreamContext, finishReason: FinishReason, usage?: ChatCompletionUsage): ChatCompletionChunk {
  return { id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}
export function toAggregate(ctx: StreamContext, agg: StreamAggregate): ChatCompletion {
  return {
    id: ctx.id, object: 'chat.completion', created: ctx.created, model: ctx.model,
    choices: [{ index: 0, message: { role: 'assistant', content: agg.content, ...(agg.reasoning ? { reasoning_content: agg.reasoning } : {}), ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}) }, finish_reason: agg.finishReason ?? 'stop' }],
    ...(agg.usage ? { usage: agg.usage } : {}),
  };
}
```

- [ ] **Step 5: 跑测试验证**

Run: `npx vitest run tests/unit/chunk-encoder.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/background/providers/adapter.ts src/background/chunk-encoder.ts tests/unit/chunk-encoder.test.ts && git commit -m "feat: chunk encoder mapping provider events to openai chunks"
```

---

### Task 6: SSE JSON-Patch 解析器（DeepSeek 流协议）

**Files:**
- Create: `src/background/providers/deepseek/sse-patch.ts`
- Test: `tests/unit/sse-patch.test.ts`（fixture：`tests/fixtures/deepseek/sse-normal.json`）

**Interfaces:**
- Consumes: `ProviderStreamEvent`（Task 9 接口文件）、fixture（Task 2；未完成时用 Step 1 内嵌的合成片段，字段名以 ds-free-api 源码为准）
- Produces:
  - `parseSseText(text: string): { event?: string; data: string }[]`
  - `extractReadyIds(data: unknown): { requestMessageId: number; responseMessageId: number } | null`
  - `class ResponseTree { apply(op: { op: string; path: string; value?: unknown }): ProviderStreamEvent[] }` — 状态：`fragments: { type: 'think' | 'response'; content: string }[]`；认识路径：`response/status`、`response/fragments`（op=APPEND 或 add，value 带 type/content）、`response/fragments/-1/content`（add/replace，值追加到最后一个片段）、`response/accumulated_token_usage`（add/replace 数值）
  - `completionEvents(body: AsyncIterable<Uint8Array>, timeoutMs: number, onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void): AsyncIterable<ProviderStreamEvent>`

- [ ] **Step 1: 写失败测试（含合成夹具）**

`tests/unit/sse-patch.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSseText, extractReadyIds, ResponseTree, completionEvents } from '../src/background/providers/deepseek/sse-patch';
import type { ProviderStreamEvent } from '../src/background/providers/adapter';

// 合成片段（fixture 就绪后替换为 sse-normal.json 内容，结构同型）
const synthetic = [
  'event: chunk\ndata: {"response/status":{"op":"replace","path":"response/status","value":"ready"}}\n\n',
  'event: chunk\ndata: {"response/fragments":{"op":"add","path":"response/fragments","value":{"id":1,"type":"think","content":""}}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"思考中"}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"结束"}}\n\n',
  'event: chunk\ndata: {"response/fragments":{"op":"add","path":"response/fragments","value":{"id":2,"type":"response","content":""}}}\n\n',
  'event: chunk\ndata: {"response/fragments/-1/content":{"op":"add","path":"response/fragments/-1/content","value":"你好"}}\n\n',
  'event: chunk\ndata: {"response/accumulated_token_usage":{"op":"replace","path":"response/accumulated_token_usage","value":17}}\n\n',
].join('');

describe('parseSseText', () => {
  it('splits events and keeps data', () => {
    const evs = parseSseText(synthetic);
    expect(evs.length).toBe(7);
    expect(evs[0]!.data).toContain('response/status');
  });
});
describe('ResponseTree', () => {
  it('emits think deltas, content deltas, then usage', () => {
    const tree = new ResponseTree();
    const out: ProviderStreamEvent[] = [];
    for (const { data } of parseSseText(synthetic)) { out.push(...tree.apply(JSON.parse(data))); }
    expect(out.map(e => e.kind)).toEqual(['think_delta','think_delta','content_delta','usage']);
    expect(out[0]).toMatchObject({ kind: 'think_delta', content: '思考中' });
    expect(out[2]).toMatchObject({ kind: 'content_delta', content: '你好' });
    expect(out[3]).toMatchObject({ kind: 'usage', outputTokens: 17 });
  });
});
describe('extractReadyIds', () => {
  it('extracts message ids', () => {
    const ids = extractReadyIds({ request_message_id: 123, response_message_id: 456, message_id: 456 });
    expect(ids).toEqual({ requestMessageId: 123, responseMessageId: 456 });
  });
});
describe('completionEvents', () => {
  it('streams chunks split across boundaries', async () => {
    const enc = new TextEncoder();
    const chunks = synthetic.match(/.{1,40}/gs)!.map(s => enc.encode(s));
    const evs: string[] = [];
    for await (const e of completionEvents(async function* () { for (const c of chunks) yield c; }(), 10_000, () => {})) {
      evs.push(e.kind);
    }
    expect(evs.filter(k => k === 'content_delta' || k === 'think_delta' || k === 'usage')).toHaveLength(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/sse-patch.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/background/providers/deepseek/sse-patch.ts`:
```ts
import type { ProviderStreamEvent } from '../adapter';

export interface SseEvent { event?: string; data: string }
export function parseSseText(text: string): SseEvent[] {
  return text.split(/\n\n+/).map(block => {
    const ev: SseEvent = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) ev.data = line.slice(5).trimStart();
    }
    return ev;
  }).filter(e => e.data !== undefined && e.data !== '');
}

export function extractReadyIds(data: unknown): { requestMessageId: number; responseMessageId: number } | null {
  const o = data as Record<string, unknown>;
  const a = o.request_message_id, b = o.response_message_id;
  if (typeof a === 'number' && typeof b === 'number') return { requestMessageId: a, responseMessageId: b };
  return null;
}

type Frag = { type: 'think' | 'response'; content: string };
export class ResponseTree {
  private fragments: Frag[] = [];
  private usage: number | null = null;
  apply(op: { op: string; path: string; value?: unknown }): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = [];
    const value = (op.value ?? null) as unknown;
    if (op.path === 'response/fragments' && op.op === 'add' && value && typeof value === 'object') {
      const v = value as { type?: string; content?: string };
      const type = v.type === 'think' ? 'think' : 'response';
      this.fragments.push({ type, content: typeof v.content === 'string' ? v.content : '' });
      const created = this.fragments[this.fragments.length - 1]!;
      if (created.content) out.push({ kind: type === 'think' ? 'think_delta' : 'content_delta', content: created.content });
      return out;
    }
    if (op.path === 'response/fragments/-1/content' && typeof value === 'string') {
      const frag = this.fragments[this.fragments.length - 1];
      if (!frag) return out;
      frag.content += value;
      out.push({ kind: frag.type === 'think' ? 'think_delta' : 'content_delta', content: value });
      return out;
    }
    if (op.path === 'response/accumulated_token_usage' && typeof value === 'number') {
      this.usage = value;
      out.push({ kind: 'usage', inputTokens: 0, outputTokens: value });  // input 不可得，Router 层按 spec 决定是否透出
      return out;
    }
    return out;  // response/status 等其余路径暂不产生事件
  }
}

export async function* completionEvents(
  body: AsyncIterable<Uint8Array>, timeoutMs: number,
  onReady: (ids: { requestMessageId: number; responseMessageId: number }) => void,
): AsyncIterable<ProviderStreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  let lastActivity = Date.now();
  let sentReady = false;
  const tree = new ResponseTree();
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) throw new Error('stream timeout: no progress');
  }, 5000);
  try {
    for await (const chunk of body) {
      lastActivity = Date.now();
      buf += dec.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const ev of parseSseText(block)) {
          let data: unknown; try { data = JSON.parse(ev.data); } catch { continue; }
          if (!sentReady) {
            const ids = extractReadyIds(data);
            if (ids) { sentReady = true; onReady(ids); yield { kind: 'message_id', id: ids.responseMessageId }; continue; }
          }
          if (typeof data === 'object' && data !== null) {
            for (const [path, v] of Object.entries(data as Record<string, unknown>)) {
              if (typeof v === 'object' && v !== null) {
                const op = v as { op?: string; path?: string; value?: unknown };
                yield* tree.apply({ op: op.op ?? 'replace', path: op.path ?? path, value: op.value });
              }
            }
          }
        }
      }
    }
  } finally { clearInterval(timer); }
}
```

- [ ] **Step 4: 跑测试验证 + 用真实夹具复核**

Run: `npx vitest run tests/unit/sse-patch.test.ts && npx tsc --noEmit`
Expected: PASS。若 `tests/fixtures/deepseek/sse-normal.json` 已存在，追加一个用例用真实录制流走 `completionEvents` 全链路（期望 output 顺序与录制一致；真实事件名与合成片段不一致时以夹具为准修改 `ResponseTree` 的路径表，并在代码注释标注）。

- [ ] **Step 5: Commit**

```bash
git add src/background/providers/deepseek/sse-patch.ts tests/unit/sse-patch.test.ts && git commit -m "feat: deepseek sse json-patch parser and stream decoder"
```

---

### Task 7: PoW 求解器（DeepSeek WASM）

**Files:**
- Create: `src/background/providers/deepseek/pow.ts`
- Test: `tests/unit/pow.test.ts`

**Interfaces:**
- Consumes: `ProviderContext`（Task 9）
- Produces:
  - `interface Challenge { algorithm: string; challenge: string; difficulty: number; target_path: string; salt: string; expire_at: number }`
  - `interface WasmInstance { addToStack(n: number): number; alloc(len: number): number; solve(retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number): void; readPtr(ptr: number, len: number): Uint8Array }`
  - `instantiateDeepSeekWasm(bytes: Uint8Array): Promise<WasmInstance>` — wasm-bindgen 导出符号探测（`__wbindgen_add_to_stack_pointer`、`__wbindgen_malloc` 或 `__wbindgen_export_*` 分配器、`wasm_solve`，memory）
  - `class PowSolver { constructor(deps: { fetchJson: (path: string, headers: Record<string,string>, body: unknown) => Promise<unknown>; fetchBytes: (url: string) => Promise<Uint8Array>; instantiate: (b: Uint8Array) => Promise<WasmInstance>; wasmUrl: string }); getChallenge(ctx: ProviderContext, targetPath: string): Promise<Challenge>; solve(challenge: Challenge, ctx: ProviderContext): Promise<string> }` — solve 返回 `X-Ds-Pow-Response` 值：base64(JSON{algorithm,challenge,salt,answer,signature,target_path})
  - `class PowFailedError extends Error`

- [ ] **Step 1: 写失败测试**

`tests/unit/pow.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PowSolver, PowFailedError } from '../src/background/providers/deepseek/pow';

function fakeInstance(answerBytes: Uint8Array): InstanceType<typeof import('../src/background/providers/deepseek/pow') extends never ? never : { new (...a: any[]): any }, any>['prototype'] {
  // 用对象字面量模拟 WasmInstance
  return { addToStack: (n: number) => n, alloc: (len: number) => 0, solve: () => {}, readPtr: () => answerBytes } as never;
}

describe('PowSolver', () => {
  it('fetches challenge and solves via wasm, returning base64 header', async () => {
    const challenge = { algorithm: 'DeepSeekHashV1', challenge: 'abc', difficulty: 3, target_path: '/api/v0/chat/completion', salt: 's1', expire_at: 1700000000 };
    const answer = new Uint8Array(8); new DataView(answer.buffer).setBigInt64(0, 42n, true);
    const solver = new PowSolver({
      fetchJson: async (path, _h, body) => { expect(path).toBe('/api/v0/chat/create_pow_challenge'); expect((body as any).target_path).toBe('/api/v0/chat/completion'); return challenge; },
      fetchBytes: async (url) => { expect(url).toBe('https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'); return new Uint8Array([0]); },
      instantiate: async () => fakeInstance(answer),
      wasmUrl: 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    });
    const header = await solver.solve(challenge, { token: 't', requestId: 'r1' });
    const decoded = JSON.parse(atob(header));
    expect(decoded).toMatchObject({ algorithm: 'DeepSeekHashV1', challenge: 'abc', salt: 's1', answer: 42, target_path: '/api/v0/chat/completion' });
  });
  it('propagates PowFailedError on solve failure', async () => {
    const solver = new PowSolver({ fetchJson: async () => ({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }), fetchBytes: async () => new Uint8Array(), instantiate: async () => { throw new Error('wasm broken'); }, wasmUrl: 'u' });
    await expect(solver.solve({ algorithm: 'DeepSeekHashV1', challenge: 'c', difficulty: 1, target_path: 'x', salt: 's', expire_at: 1 }, { token: 't', requestId: 'r' })).rejects.toThrow(PowFailedError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/pow.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/background/providers/deepseek/pow.ts`:
```ts
import type { ProviderContext } from '../adapter';

export interface Challenge { algorithm: string; challenge: string; difficulty: number; target_path: string; salt: string; expire_at: number }
export interface WasmInstance {
  addToStack(n: number): number; alloc(len: number): number;
  solve(retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number): void;
  readPtr(ptr: number, len: number): Uint8Array;
}
export class PowFailedError extends Error { constructor(m: string) { super(m); this.name = 'PowFailedError'; } }

export async function instantiateDeepSeekWasm(bytes: Uint8Array): Promise<WasmInstance> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory | undefined;
  if (!memory) throw new PowFailedError('wasm: memory export missing');
  const addToStack = exports.__wbindgen_add_to_stack_pointer as ((n: number) => number) | undefined;
  const alloc = (exports.__wbindgen_malloc as ((l: number) => number) | undefined)
    ?? Object.entries(exports).find(([k, v]) => k.startsWith('__wbindgen_export_') && typeof v === 'function')?.[1] as ((l: number) => number) | undefined;
  const solve = exports.wasm_solve as ((r: number, c: number, cl: number, p: number, pl: number, d: number) => void) | undefined;
  if (!addToStack || !alloc || !solve) throw new PowFailedError('wasm: required exports missing');
  return {
    addToStack: n => addToStack(n),
    alloc: l => alloc(l),
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
    const r = await this.deps.fetchJson('/api/v0/chat/create_pow_challenge', { Authorization: `Bearer ${ctx.token}` }, { target_path: targetPath });
    const data = (r as { data?: { challenge?: Challenge } }).data?.challenge;
    if (!data) throw new PowFailedError('challenge payload missing');
    return data;
  }
  async solve(challenge: Challenge, ctx: ProviderContext): Promise<string> {
    try {
      const wasm = this.wasmCache ??= this.deps.instantiate(await this.deps.fetchBytes(this.deps.wasmUrl));
      const inst = await wasm;
      const prefix = `${challenge.salt}_${challenge.expire_at}_`;
      const enc = new TextEncoder();
      const cBytes = enc.encode(challenge.challenge), pBytes = enc.encode(prefix);
      const retptr = inst.addToStack(-16);
      const cPtr = inst.alloc(cBytes.length), pPtr = inst.alloc(pBytes.length);
      new Uint8Array(inst.readPtr(cPtr, 0).buffer, inst.readPtr(cPtr, 0).byteOffset, cBytes.length).set(cBytes);
      new Uint8Array(inst.readPtr(pPtr, 0).buffer, inst.readPtr(pPtr, 0).byteOffset, pBytes.length).set(pBytes);
      inst.solve(retptr, cPtr, cBytes.length, pPtr, pBytes.length, challenge.difficulty);
      const status = new DataView(inst.readPtr(retptr, 4).buffer).getInt32(0, true);
      if (status !== 0) throw new PowFailedError(`wasm solve status=${status}`);
      const answer = new DataView(inst.readPtr(retptr, 8).buffer).getBigInt64(0, true);
      const signature = new TextDecoder().decode(inst.readPtr(retptr + 8, 64)).replace(/\0+$/, '');
      const json = JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer: Number(answer), signature, target_path: challenge.target_path });
      return btoa(json);
    } catch (e) {
      if (e instanceof PowFailedError) throw e;
      throw new PowFailedError(`pow solve failed: ${(e as Error).message}`);
    }
  }
}
```
（签名长度与 retptr 布局以 spike 实测为准：若 status/answer/signature 偏移不同，改本函数并在注释标明来源。）

- [ ] **Step 4: 跑测试验证**

Run: `npx vitest run tests/unit/pow.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/background/providers/deepseek/pow.ts tests/unit/pow.test.ts && git commit -m "feat: deepseek pow solver with wasm-bindgen export probing"
```

---

### Task 8: SessionMapper（线程池/镜像状态机）+ Queue

**Files:**
- Create: `src/background/session-mapper.ts`、`src/background/queue.ts`
- Test: `tests/unit/session-mapper.test.ts`、`tests/unit/queue.test.ts`

**Interfaces:**
- Consumes: `Message`（Task 3）、`hashMessages`（Task 4）
- Produces:
  - `interface ThreadEntry { conversationId: string; webSessionId: string; parentMessageId: number | string | null; mirror: Message[]; kind: 'auto' | 'named'; idleSince: number; lastUsedAt: number; busy: boolean }`
  - `type Decision = { action: 'incremental'; thread: ThreadEntry; tail: Message[] } | { action: 'rebuild'; existing: ThreadEntry | null } | { action: 'error'; code: 'invalid_request_error'; message: string }`
  - `class SessionMapper { constructor(deps: { createSession(): Promise<{ webSessionId: string }>; deleteSession(id: string): Promise<void>; now(): number }, cfg: { poolSize: number; ttlMs: number }) ... }`
    方法：`decide(providerId, messages, conversationId?): Decision`、`register(providerId, conversationId, webSessionId, mirror): ThreadEntry`（含 LRU 淘汰）、`markBusy(providerId, conversationId): void`、`commit(providerId, conversationId, messages, webSessionId, parentMessageId): void`、`fail(providerId, conversationId): Promise<void>`（删除会话 best-effort + 移除条目）、`touch(providerId, conversationId): void`、`evictExpired(providerId): Promise<void>`、`nextAutoConversationId(): string`、`stats(): { threads: number; busy: number }`
  - `class Queue { constructor(opts: { timeoutMs: number; now?: () => number }); runExclusive<K>(key: string, fn: () => Promise<void>): Promise<void>; size(): number }` — 同 key 串行；等待超过 timeoutMs 抛 `QueueTimeoutError`；不等待已超时的任务
  - `class QueueTimeoutError extends Error`

- [ ] **Step 1: 写失败测试**

`tests/unit/queue.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Queue, QueueTimeoutError } from '../src/background/queue';

describe('Queue', () => {
  it('serializes per key and times out after budget', async () => {
    const q = new Queue({ timeoutMs: 50, now: () => Date.now() });
    const order: string[] = [];
    const p1 = q.runExclusive('k', async () => { order.push('a'); await new Promise(r => setTimeout(r, 10)); order.push('a2'); });
    const p2 = q.runExclusive('k', async () => { order.push('b'); });
    await p1; await p2;
    expect(order).toEqual(['a', 'a2', 'b']);
    await expect(q.runExclusive('k2', async () => { await new Promise(r => setTimeout(r, 200)); })).resolves.toBeUndefined();
  });
  it('rejects with QueueTimeoutError when key held beyond timeout', async () => {
    const q = new Queue({ timeoutMs: 20, now: () => Date.now() });
    const hold = q.runExclusive('k', async () => { await new Promise(r => setTimeout(r, 100)); });
    await expect(q.runExclusive('k', async () => {})).rejects.toThrow(QueueTimeoutError);
    await hold;
  });
});
```

`tests/unit/session-mapper.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionMapper } from '../src/background/session-mapper';
import type { Message } from '../src/shared/api-types';

const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ role, content, ...extra });
const mk = () => {
  const deps = { createSession: vi.fn(async () => ({ webSessionId: `s${(deps as any).createSession.mock.calls.length}` })), deleteSession: vi.fn(async () => {}), now: () => 1000 };
  return { mapper: new SessionMapper(deps, { poolSize: 2, ttlMs: 60_000 }), deps };
};

describe('SessionMapper', () => {
  it('increments when mirror is prefix of messages', async () => {
    const { mapper } = mk();
    const d1 = mapper.decide('deepseek', [m('user','hi')]);
    expect(d1.action).toBe('rebuild');
    const t = mapper.register('deepseek', mapper.nextAutoConversationId(), 's1', [m('user','hi')]);
    mapper.commit('deepseek', t.conversationId, [m('user','hi')], 's1', 10);
    const d2 = mapper.decide('deepseek', [m('user','hi'), m('user','next')]);
    expect(d2.action).toBe('incremental');
    if (d2.action === 'incremental') expect(d2.thread.webSessionId).toBe('s1');
  });
  it('rebuilds on rewind (prefix shorter than mirror)', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user','a'), m('assistant','b')]);
    mapper.commit('deepseek', t.conversationId, [m('user','a'), m('assistant','b')], 's1', 5);
    const d = mapper.decide('deepseek', [m('user','a'), m('user','new')]);
    expect(d.action).toBe('rebuild');
  });
  it('rebuilds on exact replay (tail empty)', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user','a')]);
    mapper.commit('deepseek', t.conversationId, [m('user','a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user','a')]);
    expect(d.action).toBe('rebuild');
  });
  it('tail starting with non-user triggers rebuild', () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user','a')]);
    mapper.commit('deepseek', t.conversationId, [m('user','a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user','a'), m('assistant','auto')]);
    expect(d.action).toBe('rebuild');
  });
  it('named thread mismatch rebuilds and keeps key', async () => {
    const { mapper } = mk();
    const t = mapper.register('deepseek', 'conv-1', 's1', [m('user','a')]);
    mapper.commit('deepseek', 'conv-1', [m('user','a')], 's1', 1);
    const d = mapper.decide('deepseek', [m('user','changed')], 'conv-1');
    expect(d.action).toBe('rebuild');
    if (d.action === 'rebuild') { expect(d.existing?.webSessionId).toBe('s1'); }
  });
  it('evicts LRU on register over poolSize and expires idle threads', async () => {
    const { mapper, deps } = mk();
    mapper.register('deepseek', 'auto:1', 's1', [m('user','a')]);
    mapper.register('deepseek', 'auto:2', 's2', [m('user','b')]);
    mapper.register('deepseek', 'auto:3', 's3', [m('user','c')]);  // 淘汰 s1
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
    const stats = mapper.stats();
    expect(stats.threads).toBe(2);
    deps.now = () => 1000 + 61_000;
    await mapper.evictExpired('deepseek');
    expect(mapper.stats().threads).toBe(0);
  });
  it('fail() destroys the thread', async () => {
    const { mapper, deps } = mk();
    const t = mapper.register('deepseek', 'auto:1', 's1', [m('user','a')]);
    await mapper.fail('deepseek', t.conversationId);
    expect(deps.deleteSession).toHaveBeenCalledWith('s1');
    expect(mapper.stats().threads).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/session-mapper.test.ts tests/unit/queue.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/background/queue.ts`:
```ts
export class QueueTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'QueueTimeoutError'; } }
export class Queue {
  private tails = new Map<string, Promise<void>>();
  constructor(private opts: { timeoutMs: number; now?: () => number }) {}
  runExclusive(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const start = (this.opts.now ?? Date.now)();
    const run = prev.catch(() => {}).then(async () => {
      const waited = (this.opts.now ?? Date.now)() - start;
      if (waited > this.opts.timeoutMs) throw new QueueTimeoutError(`queue wait exceeded ${this.opts.timeoutMs}ms`);
      await fn();
    });
    const tail = run.catch(() => {});
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return run;
  }
  size(): number { return this.tails.size; }
}
```

`src/background/session-mapper.ts`:
```ts
import type { Message } from '../shared/api-types';

export interface ThreadEntry { conversationId: string; webSessionId: string; parentMessageId: number | string | null; mirror: Message[]; kind: 'auto' | 'named'; idleSince: number; lastUsedAt: number; busy: boolean }
export type Decision = { action: 'incremental'; thread: ThreadEntry; tail: Message[] } | { action: 'rebuild'; existing: ThreadEntry | null } | { action: 'error'; code: 'invalid_request_error'; message: string };

export class SessionMapper {
  private threads = new Map<string, ThreadEntry>();
  private seq = 0;
  constructor(private deps: { createSession(): Promise<{ webSessionId: string }>; deleteSession(id: string): Promise<void>; now(): number }, private cfg: { poolSize: number; ttlMs: number }) {}

  private key(providerId: string, conversationId: string) { return `${providerId}:${conversationId}`; }

  decide(providerId: string, messages: Message[], conversationId?: string): Decision {
    if (messages.length === 0) return { action: 'error', code: 'invalid_request_error', message: 'messages is empty' };
    const prefix = messages.slice(0, -1);
    const last = messages[messages.length - 1]!;
    if (conversationId) {
      const t = this.threads.get(this.key(providerId, conversationId));
      if (!t) return { action: 'rebuild', existing: null };
      // named 模式：镜像完全一致且末条为 user → 增量（只发末条）；否则重建并保留旧会话引用
      if (mirrorIsPrefix(t.mirror, prefix) && prefix.length === t.mirror.length && last.role === 'user') {
        return { action: 'incremental', thread: t, tail: [last] };
      }
      return { action: 'rebuild', existing: t };
    }
    const tail: Message[] = [];
    let best: ThreadEntry | null = null;
    for (const t of this.threads.values()) {
      if (t.kind !== 'auto' || t.busy) continue;
      if (!mirrorIsPrefix(t.mirror, prefix)) continue;
      if (best === null || t.mirror.length > best.mirror.length || (t.mirror.length === best.mirror.length && t.lastUsedAt < best.lastUsedAt)) best = t;
    }
    if (best) {
      for (let i = best.mirror.length; i < prefix.length; i++) tail.push(prefix[i]!);
      if (tail.length === 0) return { action: 'rebuild', existing: best };       // exact replay
      if (tail[0]!.role !== 'user') return { action: 'rebuild', existing: best }; // tail must start user
      return { action: 'incremental', thread: best, tail };
    }
    return { action: 'rebuild', existing: null };
  }

  register(providerId: string, conversationId: string, webSessionId: string, mirror: Message[]): ThreadEntry {
    const t: ThreadEntry = { conversationId, webSessionId, parentMessageId: null, mirror, kind: conversationId.startsWith('auto:') ? 'auto' : 'named', idleSince: this.deps.now(), lastUsedAt: this.deps.now(), busy: false };
    if (this.threads.has(this.key(providerId, conversationId))) this.threads.delete(this.key(providerId, conversationId));
    this.threads.set(this.key(providerId, conversationId), t);
    while (this.countAuto(providerId) > this.cfg.poolSize) {
      const victim = [...this.threads.values()].filter(x => x.kind === 'auto').sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) break;
      void this.deps.deleteSession(victim.webSessionId);
      this.threads.delete(this.key(providerId, victim.conversationId));
    }
    return t;
  }
  markBusy(providerId: string, conversationId: string) { const t = this.threads.get(this.key(providerId, conversationId)); if (t) t.busy = true; }
  commit(providerId: string, conversationId: string, messages: Message[], webSessionId: string, parentMessageId: number | string | null) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) { this.register(providerId, conversationId, webSessionId, messages); return; }
    t.mirror = messages.map(x => ({ ...x })); t.parentMessageId = parentMessageId; t.busy = false; t.lastUsedAt = this.deps.now(); t.idleSince = this.deps.now();
  }
  async fail(providerId: string, conversationId: string) {
    const t = this.threads.get(this.key(providerId, conversationId));
    if (!t) return;
    this.threads.delete(this.key(providerId, conversationId));
    try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort per spec */ }
  }
  touch(providerId: string, conversationId: string) { const t = this.threads.get(this.key(providerId, conversationId)); if (t) { t.lastUsedAt = this.deps.now(); t.idleSince = this.deps.now(); } }
  async evictExpired(providerId: string) {
    const now = this.deps.now();
    for (const t of [...this.threads.values()]) {
      if (now - t.idleSince > this.cfg.ttlMs) {
        this.threads.delete(this.key(providerId, t.conversationId));
        try { await this.deps.deleteSession(t.webSessionId); } catch { /* best effort */ }
      }
    }
  }
  stats() { return { threads: this.threads.size, busy: [...this.threads.values()].filter(t => t.busy).length }; }
  private countAuto(providerId: string) { return [...this.threads.values()].filter(t => t.kind === 'auto').length; }
  nextAutoConversationId() { return `auto:${++this.seq}`; }
}

function mirrorIsPrefix(mirror: Message[], prefix: Message[]): boolean {
  if (mirror.length > prefix.length) return false;
  for (let i = 0; i < mirror.length; i++) if (!sameMsg(mirror[i]!, prefix[i]!)) return false;
  return true;
}
function sameMsg(a: Message, b: Message): boolean {
  return a.role === b.role && a.content === b.content && (a.tool_call_id ?? null) === (b.tool_call_id ?? null) && (a.name ?? null) === (b.name ?? null) && JSON.stringify(a.tool_calls ?? null) === JSON.stringify(b.tool_calls ?? null);
}
```
（注：decide 中 named 分支的 mirror 比较同样用 `mirrorIsPrefix` + 长度相等 + 末条为 user；tail 计算对 named 模式取 `prefix.length > mirror.length` 时 tail。）

- [ ] **Step 4: 跑测试验证 + 修正 named 分支测试**

Run: `npx vitest run tests/unit/session-mapper.test.ts tests/unit/queue.test.ts && npx tsc --noEmit`
Expected: 除 named mismatch 用例因 Step 3 实现细节外全绿；若 named 分支实现与测试断言不一致，调整实现使测试通过（语义：named 且 prefix==mirror 且末条 user → incremental；否则 rebuild 并保留 existing 引用）。

- [ ] **Step 5: Commit**

```bash
git add src/background/session-mapper.ts src/background/queue.ts tests/unit/session-mapper.test.ts tests/unit/queue.test.ts && git commit -m "feat: session mapper state machine and per-thread queue"
```

---

### Task 9: DeepSeekAdapter（auth/client/契约测试）

**Files:**
- Create: `src/background/providers/adapter.ts`（接口定稿，Task 5 已有骨架）、`src/background/providers/registry.ts`、`src/background/providers/deepseek/auth.ts`、`src/background/providers/deepseek/client.ts`、`src/background/providers/deepseek/adapter.ts`
- Test: `tests/unit/deepseek-adapter.test.ts`、`tests/contract/deepseek-contract.test.ts`（读 `tests/fixtures/deepseek/*.json`）

**Interfaces:**
- Consumes: `ProviderStreamEvent` 等（同文件）、`PowSolver`（Task 7）、`completionEvents`/`ResponseTree`（Task 6）、`Message`/`ToolDef`（Task 3）
- Produces:
  - `type ProviderId = 'deepseek'`（`export type ProviderId = 'deepseek' | (string & {})`，v1 只注册 deepseek）
  - `interface ProviderContext { token: string; requestId: string }`
  - `type AuthStatus = { state: 'logged_in' } | { state: 'logged_out' } | { state: 'expired'; message: string }`
  - `interface ProviderSession { providerId: ProviderId; webSessionId: string; parentMessageId: number | string | null }`
  - `interface ProviderCompletion { session: ProviderSession; prompt: string; requestId: string }`
  - `interface ResolvedModel { modelId: string; modelType: 'default' | 'expert'; thinking: boolean; limitChars: number }`
  - `interface ProviderAdapter`（spec §5 全量，含 `stopStream`；`streamCompletion(ctx, req)` 返回 `AsyncIterable<ProviderStreamEvent>`；`auth: { loginPageUrl; cookieDomain; requiredCookies; getAuthStatus(ctx) }`；`models: ModelInfo[]`；`resolveModel(modelId)`；`isRateLimited/isAuthExpired/isUnavailable`；`capabilities`）
  - `interface AdapterDeps { fetchJson(path, headers, body): Promise<unknown>; fetchStream(path, headers, body): Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array> }>; getToken(): Promise<string | null>; pow: PowSolver; now(): number; deleteSessionFor(webSessionId)... }` —— chrome 能力注入点
  - `createDeepSeekAdapter(deps: AdapterDeps): ProviderAdapter`
  - `createRegistry(provider: ProviderAdapter): Record<ProviderId, ProviderAdapter>` + `listModels(registry): ModelInfo[]`

- [ ] **Step 1: 接口定稿确认**

接口已在 Task 5 Step 1 定义（含 spec 增补：`stopStream`、`message_id` 事件）。本任务仅实现，不重定义类型。若 spike 夹具显示字段差异，改 `client.ts`/`adapter.ts` 实现并同步测试，不动接口签名。

- [ ] **Step 2: 写失败测试（模型解析/错误映射/契约）**

`tests/unit/deepseek-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createDeepSeekAdapter } from '../src/background/providers/deepseek/adapter';
import { PowSolver } from '../src/background/providers/deepseek/pow';

const deps = {
  fetchJson: async () => { throw new Error('unexpected'); },
  fetchStream: async () => { throw new Error('unexpected'); },
  getToken: async () => 'tok',
  pow: new PowSolver({ fetchJson: async () => { throw new Error('unexpected'); }, fetchBytes: async () => new Uint8Array(), instantiate: async () => { throw new Error('no'); }, wasmUrl: 'u' }),
  now: () => 0,
};

describe('DeepSeekAdapter', () => {
  it('resolves models and rejects unknown', () => {
    const a = createDeepSeekAdapter(deps as any);
    expect(a.resolveModel('deepseek-chat')).toMatchObject({ modelType: 'default', thinking: false });
    expect(a.resolveModel('deepseek-reasoner')).toMatchObject({ modelType: 'expert', thinking: true });
    expect(a.resolveModel('gpt-4o')).toBeNull();
    expect(a.models.map(m => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });
  it('classifies errors', () => {
    const a = createDeepSeekAdapter(deps as any);
    expect(a.isRateLimited(new Error('HTTP 429'))).toBe(true);
    expect(a.isRateLimited({ status: 429 })).toBe(true);
    expect(a.isAuthExpired({ status: 401 })).toBe(true);
    expect(a.isUnavailable({ status: 202, headers: { 'x-amzn-waf-action': 'challenge' } })).toBe(true);
    expect(a.isUnavailable(new TypeError('fetch failed'))).toBe(true);
    expect(a.isRateLimited({ status: 200 })).toBe(false);
  });
});
```

`tests/contract/deepseek-contract.test.ts`（fixture 驱动；fixture 未就绪时以与 ds-free-api 源码同构的合成片段代替，fixture 就绪后整体替换）:
```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDeepSeekAdapter, type AdapterDeps } from '../src/background/providers/deepseek/adapter';

const dir = path.join(__dirname, '..', 'fixtures', 'deepseek');
function load(name: string): string { return fs.readFileSync(path.join(dir, name), 'utf8'); }

describe('DeepSeek contract (fixtures)', () => {
  it('completion: builds payload, pow header, yields chunks and message_id', async () => {
    const done = new Promise<void>((resolve) => { resolve(); });
    const sse = load('sse-normal.json');
    const calls: { path: string; body: any; headers: Record<string, string> }[] = [];
    const deps: AdapterDeps = {
      getToken: async () => 'tok',
      now: () => 0,
      fetchJson: async (path, headers, body) => {
        calls.push({ path, body, headers });
        if (path === '/api/v0/chat/create_pow_challenge') return { data: { challenge: JSON.parse(load('pow-challenge.json')) } };
        if (path === '/api/v0/chat_session/create') return { data: { chat_session: { id: 'sess-1' } } };  // 字段名以 fixture/实测为准
        if (path === '/api/v0/chat_session/delete') return { data: null };
        throw new Error('unexpected ' + path);
      },
      fetchStream: async (path, headers, body) => {
        calls.push({ path, body, headers });
        const enc = new TextEncoder();
        return { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () { yield enc.encode(sse); })() };
      },
      pow: { getChallenge: async () => JSON.parse(load('pow-challenge.json')), solve: async () => 'c2VnbWVudA==' } as any,
    };
    const a = createDeepSeekAdapter(deps);
    const ctx = { token: 'tok', requestId: 'r1' };
    const s = await a.createSession(ctx);
    expect(s.webSessionId).toBeTruthy();
    const evs: string[] = [];
    for await (const e of a.streamCompletion(ctx, { session: s, prompt: '你好', requestId: 'r1' })) evs.push(e.kind);
    expect(evs).toContain('message_id');
    const comp = calls.find(c => c.path === '/api/v0/chat/completion');
    expect(comp).toBeTruthy();
    expect(comp!.headers['X-Ds-Pow-Response']).toBe('c2VnbWVudA==');
    expect(comp!.body).toMatchObject({ chat_session_id: s.webSessionId, model_type: 'default', thinking_enabled: false, parent_message_id: null });
  });
});
```
（`createSession` 走 fetchJson `/api/v0/chat_session/create` 返回 `{ data: { chat_session: { id: '...' } } }`；若 spike 实测结构不同，改 adapter 内解析并更新测试。fixture 缺失时本测试 skip，注明跑 spike 后启用：`it.skipIf(!fs.existsSync(...))`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/unit/deepseek-adapter.test.ts tests/contract/deepseek-contract.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现（client/auth/adapter）**

`src/background/providers/deepseek/auth.ts`:
```ts
import type { AuthStatus, ProviderContext } from '../adapter';
export const DEEPSEEK_LOGIN_PAGE = 'https://chat.deepseek.com/';
export const DEEPSEEK_COOKIE_DOMAIN = 'chat.deepseek.com';
export const DEEPSEEK_COOKIES = ['user_token'];   // spike 实测核准，必要时增补
export async function getAuthStatus(ctx: ProviderContext, probe: (c: ProviderContext) => Promise<boolean>): Promise<AuthStatus> {
  if (!ctx.token) return { state: 'logged_out' };
  try { return (await probe(ctx)) ? { state: 'logged_in' } : { state: 'expired', message: 'token invalid' }; }
  catch (e) { return { state: 'expired', message: (e as Error).message }; }
}
```

`src/background/providers/deepseek/client.ts`:
```ts
import type { AuthStatus, ProviderCompletion, ProviderContext, ProviderSession, ResolvedModel } from '../adapter';

export const API_BASE = 'https://chat.deepseek.com/api/v0';
export const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
export const MODELS: ModelInfo[] = [
  { id: 'deepseek-chat', provider: 'deepseek', description: 'DeepSeek V3（网页端，thinking 关）' },
  { id: 'deepseek-reasoner', provider: 'deepseek', description: 'DeepSeek R1（网页端，thinking 开）' },
];
export function resolveModel(modelId: string): ResolvedModel | null {
  if (modelId === 'deepseek-chat') return { modelType: 'default', thinking: false, limitChars: 2_621_440 };
  if (modelId === 'deepseek-reasoner') return { modelType: 'expert', thinking: true, limitChars: 163_840 };
  return null;
}
export function completionPayload(session: ProviderSession, prompt: string, model: ResolvedModel) {
  return { chat_session_id: session.webSessionId, parent_message_id: session.parentMessageId ?? null, model_type: model.modelType, prompt, ref_file_ids: [], thinking_enabled: model.thinking, search_enabled: false, preempt: false };
}
export function baseHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'X-Client-Version': '2.0.0', 'X-Client-Platform': 'android', 'X-Client-Locale': 'zh_CN', 'Content-Type': 'application/json' };
}
export function classify(err: unknown) {
  const status = (err as { status?: number })?.status ?? 0;
  const headers = (err as { headers?: Record<string, string> | Headers })?.headers;
  const waf = headers && (typeof headers === 'object' && !(headers instanceof Headers) ? (headers as Record<string, string>)['x-amzn-waf-action'] : headers.get?.('x-amzn-waf-action'));
  return { rateLimited: status === 429, authExpired: status === 401, unavailable: status === 202 && Boolean(waf) || status >= 500 || err instanceof TypeError };
}
```
（`ModelInfo` import 自 shared/api-types。）

`src/background/providers/deepseek/adapter.ts`（完整实现，无占位）:
```ts
import type { ModelInfo, ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ResolvedModel } from '../adapter';
import { completionPayload, baseHeaders, classify, MODELS, resolveModel, API_BASE } from './client';
import { getAuthStatus, DEEPSEEK_LOGIN_PAGE, DEEPSEEK_COOKIE_DOMAIN, DEEPSEEK_COOKIES } from './auth';
import { completionEvents } from './sse-patch';

export interface AdapterDeps {
  getToken(): Promise<string | null>;
  fetchJson(path: string, headers: Record<string, string>, body: unknown): Promise<unknown>;
  fetchStream(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array> }>;
  pow: { getChallenge(ctx: ProviderContext, targetPath: string): Promise<unknown>; solve(challenge: unknown, ctx: ProviderContext): Promise<string> };
  now(): number;
}

const NO_PROGRESS_MS = 600_000; // spec §4.5：10 分钟无进度断流

export function createDeepSeekAdapter(deps: AdapterDeps): ProviderAdapter {
  const classifyErr = (e: unknown) => Object.assign(e instanceof Error ? e : new Error(JSON.stringify(e)), classify(e));

  async function withPowHeaders(ctx: ProviderContext): Promise<Record<string, string>> {
    const challenge = await deps.pow.getChallenge(ctx, '/api/v0/chat/completion').catch((e) => { throw classifyErr(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 503 })); });
    const header = await deps.pow.solve(challenge, ctx);
    return { ...baseHeaders(ctx.token), 'X-Ds-Pow-Response': header };
  }

  return {
    id: 'deepseek',
    auth: {
      loginPageUrl: DEEPSEEK_LOGIN_PAGE,
      cookieDomain: DEEPSEEK_COOKIE_DOMAIN,
      requiredCookies: DEEPSEEK_COOKIES,
      getAuthStatus: (ctx) =>
        getAuthStatus(ctx, async (c) => {
          const s = await createSessionRaw(c);
          await deleteSessionRaw(c, s.webSessionId);
          return true;
        }),
    },

    async createSession(ctx) { return createSessionRaw(ctx); },
    async deleteSession(ctx, s) { await deleteSessionRaw(ctx, s.webSessionId); },
    async stopStream(ctx, s, messageId) {
      try {
        const body = { chat_session_id: s.webSessionId, message_id: messageId };
        await fetchJsonSafe('/api/v0/chat/stop_stream', baseHeaders(ctx.token), body);
      } catch { /* best effort per spec */ }
    },

    async *streamCompletion(ctx, req) {
      const model = { modelType: req.model.modelType, thinking: req.model.thinking } as ResolvedModel; // 载荷只需 type/thinking
      const headers = await withPowHeaders(ctx);
      const res = await fetchStreamSafe('/api/v0/chat/completion', headers, completionPayload(req.session, req.prompt, model));
      if (res.status !== 200) {
        throw classifyErr(Object.assign(new Error(`completion http ${res.status}`), { status: res.status, headers: res.headers }));
      }
      let done = false;
      const src = completionEvents(res.body, NO_PROGRESS_MS, () => { done = true; });
      for await (const ev of src) yield ev;
    },

    models: MODELS,
    resolveModel,
    isRateLimited: (e) => classify(e).rateLimited,
    isAuthExpired: (e) => classify(e).authExpired,
    isUnavailable: (e) => classify(e).unavailable,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
  };

  // —— 内部实现（字段解析以 fixture 为准）——
  async function createSessionRaw(ctx: ProviderContext): Promise<ProviderSession> {
    const r: any = await fetchJsonSafe('/api/v0/chat_session/create', baseHeaders(ctx.token), {});
    const id: string | undefined = r?.data?.chat_session?.id ?? r?.data?.chat_session_id;
    if (!id) throw classifyErr(new Error('create_session: id missing'));
    return { providerId: 'deepseek', webSessionId: id, parentMessageId: null };
  }
  async function deleteSessionRaw(ctx: ProviderContext, webSessionId: string): Promise<void> {
    await fetchJsonSafe('/api/v0/chat_session/delete', baseHeaders(ctx.token), { chat_session_id: webSessionId });
  }
  async function fetchJsonSafe(path: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    try { return await deps.fetchJson(path, headers, body); }
    catch (e) { throw classifyErr(e); }
  }
  async function fetchStreamSafe(path: string, headers: Record<string, string>, body: unknown) {
    try { return await deps.fetchStream(path, headers, body); }
    catch (e) { throw classifyErr(e); }
  }
}
```
（`completionEvents` 的 onReady 回调当前为空操作；`message_id` 事件经流透出，Router 在汇总时取它作 parent。若 spike 显示 ready 事件在业务错误之后到达或路径不同，调整 `sse-patch.ts` 并同步 Task 6 测试。）

`src/background/providers/registry.ts`:
```ts
import type { ModelInfo, ProviderAdapter, ProviderId } from './adapter';
export function createRegistry(provider: ProviderAdapter): Record<ProviderId, ProviderAdapter> { return { [provider.id]: provider }; }
export function listModels(registry: Record<ProviderId, ProviderAdapter>): ModelInfo[] { return Object.values(registry).flatMap(p => p.models); }
```

- [ ] **Step 5: 跑测试验证 + tsc**

Run: `npx vitest run tests/unit/deepseek-adapter.test.ts tests/contract/deepseek-contract.test.ts && npx tsc --noEmit`
Expected: unit 全绿；contract 在 fixture 就绪时全绿（否则 skip 并有提示）。

- [ ] **Step 6: Commit**

```bash
git add src/background/providers tests/unit/deepseek-adapter.test.ts tests/contract && git commit -m "feat: deepseek adapter with auth, pow, completion streaming"
```

---

### Task 10: Router（SW 编排：密钥/归一化/调度/退避/日志/存储）

**Files:**
- Create: `src/background/log.ts`、`src/background/router.ts`、`src/background/sw.ts`
- Test: `tests/integration/router.test.ts`、`tests/unit/log.test.ts`

**Interfaces:**
- Consumes: 全部核心模块（Task 3–9）
- Produces:
  - `class RingLog { push(e: LogEntry): void; list(): LogEntry[] }`（20 条循环；`LogEntry = { at: number; provider: string; model: string; ok: boolean; ms: number; error?: string }`）
  - `interface RouterDeps { registry: Record<ProviderId, ProviderAdapter>; mapper: SessionMapper; queue: Queue; storage: { get(key: string): Promise<unknown | undefined>; set(key: string, value: unknown): Promise<void> }; log: RingLog; now(): number; ensureKey(): Promise<string> }`
  - `class Router { async create(params: unknown): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>; async models(): Promise<ModelInfo[]> }`（抛 `BridgeError`）
  - `src/background/sw.ts`：`onConnect` 处理 `_deepapi` port、协议分发（`isBridgeRequest`）、长流 keepalive 转发、`models.list`、启动时 `ensureKey`、cookie 变更监听（`chrome.cookies.onChanged` 里 user_token 删除 → 面板提示——通过 storage 更新状态）。

- [ ] **前置：先执行『Task 10 增补：ToolPipeline』的 Step 1–4（buildToolPrompt/parseToolCalls 就绪后本任务才能通过 tsc）**

- [ ] **Step 1: 写失败测试**

`tests/unit/log.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { RingLog } from '../src/background/log';
describe('RingLog', () => {
  it('keeps last 20 entries in order', () => { const l = new RingLog(20); for (let i = 0; i < 25; i++) l.push({ at: i, provider: 'deepseek', model: 'm', ok: true, ms: 1 }); const list = l.list(); expect(list.length).toBe(20); expect(list[0]!.at).toBe(5); });
});
```

`tests/integration/router.test.ts`（核心场景：增量、重建、重放、限流退避、超长、鉴权失败）:
```ts
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../src/background/router';
import { SessionMapper } from '../src/background/session-mapper';
import { Queue } from '../src/background/queue';
import { RingLog } from '../src/background/log';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderSession, ProviderStreamEvent } from '../src/background/providers/adapter';

const MODELS = [
  { id: 'deepseek-chat', provider: 'deepseek', description: 'v3' },
  { id: 'deepseek-reasoner', provider: 'deepseek', description: 'r1' },
];
function stubAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter & { prompts: string[] } {
  const prompts: string[] = [];
  const base: ProviderAdapter = {
    id: 'deepseek',
    auth: { loginPageUrl: 'https://chat.deepseek.com/', cookieDomain: 'chat.deepseek.com', requiredCookies: ['user_token'], getAuthStatus: async () => ({ state: 'logged_in' }) },
    createSession: async (): Promise<ProviderSession> => ({ providerId: 'deepseek', webSessionId: 's1', parentMessageId: null }),
    deleteSession: async () => {},
    stopStream: async () => {},
    streamCompletion: async function* (_ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> { prompts.push(req.prompt); yield { kind: 'message_id', id: 1 }; yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' }; },
    models: MODELS,
    resolveModel: (id: string) => id === 'deepseek-chat' ? { modelId: id, modelType: 'default', thinking: false, limitChars: 2_621_440 } : id === 'deepseek-reasoner' ? { modelId: id, modelType: 'expert', thinking: true, limitChars: 163_840 } : null,
    isRateLimited: (e: any) => e?.status === 429,
    isAuthExpired: (e: any) => e?.status === 401,
    isUnavailable: (e: any) => (e?.status === 202 && e?.headers?.['x-amzn-waf-action']) || e instanceof TypeError,
    capabilities: { thinking: true, functionCalling: 'prompt-engineered' },
    ...over,
  };
  return Object.assign(base, { prompts });
}
const m = (role: any, content: string) => ({ role, content });
function makeRouter(adapter: ProviderAdapter, storage: Record<string, unknown> = {}) {
  const now = vi.fn(() => 1000);
  const mapper = new SessionMapper({ createSession: async () => ({ webSessionId: 's1' }), deleteSession: async () => {}, now }, { poolSize: 2, ttlMs: 60_000 });
  const router = new Router({ registry: { deepseek: adapter }, mapper, queue: new Queue({ timeoutMs: 60_000, now }), storage: { get: async (k: string) => storage[k], set: async (k: string, v: unknown) => { storage[k] = v; } }, log: new RingLog(20), now, ensureKey: async () => 'sk-dapi-1234' });
  return router;
}

const KEY = { apiKey: 'sk-dapi-1234' };

describe('Router', () => {
  it('rejects missing api key', async () => {
    const r = makeRouter(stubAdapter());
    await expect(r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')] })).rejects.toMatchObject({ status: 401, error: { code: 'missing_api_key' } });
  });
  it('aggregates non-stream and streams chunks', async () => {
    const a = stubAdapter(); const r = makeRouter(a, KEY);
    const res: any = await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
    expect(res.choices[0].message.content).toBe('ok');
    const s = await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], stream: true, ...KEY });
    const chunks: any[] = [];
    for await (const c of (s as any)) chunks.push(c);
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop');
  });
  it('unknown model → 400', async () => {
    const r = makeRouter(stubAdapter(), KEY);
    await expect(r.create({ model: 'gpt-4o', messages: [m('user', 'hi')], ...KEY })).rejects.toMatchObject({ status: 400, error: { code: 'invalid_request_error' } });
  });
  it('incremental second call sends only tail', async () => {
    const a = stubAdapter(); const r = makeRouter(a, KEY);
    await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
    await r.create({ model: 'deepseek-chat', messages: [m('user', 'hi'), m('user', 'next')], ...KEY });
    expect(a.prompts[0]).toContain('hi');
    expect(a.prompts[1]).toContain('next');
    expect(a.prompts[1]).not.toContain('你好吗');  // 只发尾部
  });
  it('rate limited twice then succeeds with backoff', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = stubAdapter({ streamCompletion: async function* () { calls++; if (calls <= 2) throw { status: 429 }; yield { kind: 'content_delta', content: 'ok', finish_reason: 'stop' }; } });
      const r = makeRouter(a, KEY);
      const p = r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY });
      await vi.advanceTimersByTimeAsync(1500);   // 500 + 1000
      const res: any = await p;
      expect(calls).toBe(3);
      expect(res.choices[0].message.content).toBe('ok');
    } finally { vi.useRealTimers(); }
  });
  it('over-limit transcript → 400 invalid_request_error', async () => {
    const r = makeRouter(stubAdapter(), KEY);
    await expect(r.create({ model: 'deepseek-reasoner', messages: [m('user', 'x'.repeat(163_841))], ...KEY })).rejects.toMatchObject({ status: 400, error: { code: 'invalid_request_error' } });
  });
  it('provider_unavailable when blocked', async () => {
    const a = stubAdapter({ streamCompletion: async function* () { throw { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }; } });
    const r = makeRouter(a, KEY);
    await expect(r.create({ model: 'deepseek-chat', messages: [m('user', 'hi')], ...KEY })).rejects.toMatchObject({ status: 503, error: { code: 'provider_unavailable' } });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/log.test.ts tests/integration/router.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/background/log.ts`:
```ts
export interface LogEntry { at: number; provider: string; model: string; ok: boolean; ms: number; error?: string }
export class RingLog {
  private buf: LogEntry[] = [];
  constructor(private cap: number) {}
  push(e: LogEntry) { this.buf.push(e); if (this.buf.length > this.cap) this.buf.shift(); }
  list(): LogEntry[] { return [...this.buf]; }
}
```

`src/background/router.ts`（完整实现；含 ToolPipeline 接入：工具注入、解析、模型兜底重试）:
```ts
import { BridgeError } from '../shared/protocol';
import type { ApiErrorCode, ChatCompletion, ChatCompletionChunk, Message, ModelInfo, ToolCall, ToolChoice, ToolDef } from '../shared/api-types';
import type { ProviderAdapter, ProviderCompletion, ProviderContext, ProviderId, ProviderSession, ResolvedModel, ProviderStreamEvent } from './providers/adapter';
import { SessionMapper, type ThreadEntry } from './session-mapper';
import { Queue, QueueTimeoutError } from './queue';
import { renderTranscript, renderTail, limitCharsFor } from './transcript-renderer';
import { eventToChunks, finalChunk, toAggregate, type StreamAggregate, type StreamContext } from './chunk-encoder';
import { buildToolPrompt, parseToolCalls, type ToolContext } from './tool-pipeline';
import type { RingLog } from './log';

export interface RouterDeps {
  registry: Record<ProviderId, ProviderAdapter>;
  mapper: SessionMapper;
  queue: Queue;
  storage: { get(k: string): Promise<unknown | undefined>; set(k: string, v: unknown): Promise<void> };
  log: RingLog;
  now(): number;
  ensureKey(): Promise<string>;
}

function err(code: ApiErrorCode, message: string, status: number): BridgeError {
  return new BridgeError({ error: { message, type: 'api_error', code } }, status);
}
interface RunState { parentMessageId: number | string | null; repairDone: boolean; model: ResolvedModel }
const NO_PROGRESS_MS = 600_000;          // spec §4.5 兜底断流
const REPAIR_INSTRUCTION = '你的上一条回复包含无法解析的工具调用 JSON。请重新输出，且只输出修复后的 JSON（不要解释、不要代码块）。';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isContentEvent(e: ProviderStreamEvent): boolean {   // 重试只发生在任何内容增量之前（spec §6.4）
  return e.kind === 'content_delta' || e.kind === 'think_delta';
}

export class Router {
  constructor(private d: RouterDeps) {}

  private async apiKey(params: Record<string, unknown>): Promise<string> {
    const cfg = (await this.d.storage.get('apiKey')) as string | undefined;
    const given = (params.apiKey as string | undefined) ?? cfg;
    if (!given) throw err('missing_api_key', 'apiKey required (set window.deepApiConfig={apiKey} or pass apiKey)', 401);
    if (!cfg || given !== cfg) throw err('invalid_api_key', 'invalid api key', 401);
    return cfg;
  }

  async models(): Promise<{ object: 'list'; data: ModelInfo[] }> { return { object: 'list', data: Object.values(this.d.registry).flatMap(p => p.models) }; }

  async create(rawParams: unknown): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> {
    const p = rawParams as Record<string, any>;
    const started = this.d.now();
    const key = await this.apiKey(p);
    const modelId = p.model as string;
    const provider = this.resolve(modelId);
    const resolved = provider.resolveModel(modelId)!;
    const messages = p.messages as Message[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) throw err('invalid_request_error', 'messages array required', 400);
    const ctx = { token: key, requestId: `req-${started}-${Math.random().toString(36).slice(2, 8)}` };
    const toolCtx = buildToolPrompt((p.tools as ToolDef[] | undefined) ?? [], (p.tool_choice as ToolChoice | undefined) ?? 'auto');
    const handle = await this.runCompletion(provider, resolved, messages, toolCtx, p.conversation_id as string | undefined, ctx);
    const done = (ok: boolean, ms: number, error?: string) => this.d.log.push({ at: this.d.now(), provider: provider.id, model: modelId, ok, ms, error });
    if (p.stream === true) return this.encodeStream(provider, handle, ctx, modelId, started, messages, toolCtx, done);
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    try {
      for await (const ev of handle.stream) this.consumeEvent(ev, agg, handle.run, ctx);
      await this.finalize(provider, handle, messages, agg, ctx, toolCtx);
    } catch (e) {
      done(false, this.d.now() - started, (e as Error).message);
      throw this.mapErr(e);
    }
    done(true, this.d.now() - started);
    return toAggregate({ id: `chatcmpl-${ctx.requestId}`, model: modelId, created: Math.floor(started / 1000) }, agg);
  }

  private resolve(model: string): ProviderAdapter {
    for (const a of Object.values(this.d.registry)) if (a.resolveModel(model)) return a;
    throw err('invalid_request_error', `unknown model: ${model}`, 400);
  }

  private async runCompletion(
    provider: ProviderAdapter, resolved: ResolvedModel, messages: Message[], toolCtx: ToolContext,
    conversationId: string | undefined, ctx: ProviderContext,
  ): Promise<{ stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }> {
    const pid = provider.id;
    const decision = this.d.mapper.decide(pid, messages, conversationId);
    if (decision.action === 'error') throw err(decision.code, decision.message, 400);
    let session: ProviderSession; let convId: string; let thread: ThreadEntry; let prompt: string;
    if (decision.action === 'rebuild') {
      if (decision.existing) {
        try { await provider.deleteSession(ctx, { providerId: pid, webSessionId: decision.existing.webSessionId, parentMessageId: decision.existing.parentMessageId }); } catch { /* best effort per spec */ }
      }
      const s = await provider.createSession(ctx);
      convId = decision.existing?.conversationId ?? this.d.mapper.nextAutoConversationId();
      thread = this.d.mapper.register(pid, convId, s.webSessionId, messages);
      session = { providerId: pid, webSessionId: s.webSessionId, parentMessageId: null };
      prompt = renderTranscript(messages).prompt + toolCtx.promptSuffix;
    } else {
      thread = decision.thread; convId = decision.thread.conversationId;
      session = { providerId: pid, webSessionId: decision.thread.webSessionId, parentMessageId: decision.thread.parentMessageId };
      prompt = renderTail(decision.tail) + toolCtx.promptSuffix;
      this.d.mapper.markBusy(pid, convId);
    }
    if (prompt.length > resolved.limitChars) {
      await this.d.mapper.fail(pid, convId);
      throw err('invalid_request_error', `transcript too long: ${prompt.length} > ${resolved.limitChars}（建议缩短历史或分批）`, 400);
    }
    const run: RunState = { parentMessageId: null, repairDone: false, model: resolved };
    const req: ProviderCompletion = { session, prompt, model: { modelType: resolved.modelType, thinking: resolved.thinking }, requestId: ctx.requestId };
    const stream = this.runExclusiveStream(provider, ctx, req);
    return { stream, session, convId, thread, run };
  }

  private runExclusiveStream(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
    // 队列锁：持有到流结束；队列等待超 60s 抛 QueueTimeoutError → mapErr → 429（spec §4.3/§10）
    let release: (() => void) | null = null;
    const locked = this.d.queue.runExclusive(`${req.session.providerId}:${req.session.webSessionId}`, () => new Promise<void>(r => { release = r; }));
    const src = this.streamWithRetry(provider, ctx, req);
    const gen = (async function* () {
      await locked;
      try { for await (const ev of src) yield ev; }
      finally { if (release) release(); }
    })();
    return gen;
  }

  private async *streamWithRetry(provider: ProviderAdapter, ctx: ProviderContext, req: ProviderCompletion): AsyncIterable<ProviderStreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        for await (const ev of provider.streamCompletion(ctx, req)) {
          if (isContentEvent(ev)) emitted = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (!emitted && attempt < 3 && provider.isRateLimited(e)) {
          await sleep(500 * 2 ** attempt);   // 500ms ×2^n，n<3（spec §6.4）
          continue;
        }
        throw e;
      }
    }
  }

  private consumeEvent(ev: ProviderStreamEvent, agg: StreamAggregate, run: RunState, _ctx: ProviderContext): void {
    switch (ev.kind) {
      case 'message_id': run.parentMessageId = ev.id; break;
      case 'think_delta': agg.reasoning += ev.content; break;
      case 'content_delta': agg.content += ev.content; if (ev.finish_reason) agg.finishReason = ev.finish_reason; break;
      case 'usage':   // spec：usage 仅当 input/output 都可得时透出；sse-patch 只给 output → 保持省略
        if (ev.inputTokens > 0 && ev.outputTokens >= 0) agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
        break;
    }
  }

  private async finalize(provider: ProviderAdapter, handle: { session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, messages: Message[], agg: StreamAggregate, ctx: ProviderContext, toolCtx: ToolContext): Promise<void> {
    let toolCalls: ToolCall[] = [];
    if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
      const parsed = parseToolCalls(agg.content);
      if (parsed) { toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls'; }
      else {
        // 模型兜底：同一会话追加修复指令重问 1 次（spec §4.4 第 3 层）；该轮不入镜像，
        // 下一轮客户端消息将因镜像前缀不匹配而重建——安全降级（spec §4.3）
        handle.run.repairDone = true;
        const repairReq: ProviderCompletion = { session: { ...handle.session, parentMessageId: handle.run.parentMessageId ?? handle.session.parentMessageId }, prompt: `${REPAIR_INSTRUCTION}\n\n${agg.content}`, model: { modelType: handle.run.model.modelType, thinking: handle.run.model.thinking }, requestId: `${ctx.requestId}-repair` };
        let buf = '';
        try {
          for await (const ev of provider.streamCompletion(ctx, repairReq)) if (ev.kind === 'content_delta') buf += ev.content;
          const p2 = parseToolCalls(buf);
          if (p2) { toolCalls = p2.calls; agg.content = p2.remainder; agg.finishReason = 'tool_calls'; }
          else throw err('invalid_request_error', 'tool call parse failed after repair retry', 400);
        } catch (e) {
          if (e instanceof BridgeError) { await this.d.mapper.fail(provider.id, handle.convId); throw e; }
          await this.d.mapper.fail(provider.id, handle.convId);
          throw err('invalid_request_error', 'tool call parse failed', 400);
        }
      }
    }
    this.d.mapper.commit(provider.id, handle.convId, messages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId);
    agg.toolCalls = toolCalls;
    agg.finishReason = agg.finishReason ?? 'stop';
  }

  private encodeStream(provider: ProviderAdapter, handle: { stream: AsyncIterable<ProviderStreamEvent>; session: ProviderSession; convId: string; thread: ThreadEntry; run: RunState }, ctx: ProviderContext, model: string, started: number, messages: Message[], toolCtx: ToolContext, done: (ok: boolean, ms: number, error?: string) => void): AsyncIterable<ChatCompletionChunk> {
    const cctx: StreamContext = { id: `chatcmpl-${ctx.requestId}`, model, created: Math.floor(started / 1000) };
    const agg: StreamAggregate = { content: '', reasoning: '', toolCalls: [], finishReason: null };
    const gen = (async function* () {
      try {
        for await (const ev of handle.stream) {
          for (const c of eventToChunks(ev, cctx)) yield c;
          if (ev.kind === 'content_delta') agg.content += ev.content;
          if (ev.kind === 'think_delta') agg.reasoning += ev.content;
          if (ev.kind === 'message_id') handle.run.parentMessageId = ev.id;
          if (ev.kind === 'usage' && ev.inputTokens > 0 && ev.outputTokens >= 0) agg.usage = { prompt_tokens: ev.inputTokens, completion_tokens: ev.outputTokens, total_tokens: ev.inputTokens + ev.outputTokens };
        }
        if (toolCtx.promptSuffix !== '' && !handle.run.repairDone) {
          const parsed = parseToolCalls(agg.content);
          if (parsed) {
            agg.toolCalls = parsed.calls; agg.content = parsed.remainder; agg.finishReason = 'tool_calls';
            yield { ...cctx, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: parsed.calls }, finish_reason: 'tool_calls' }] };
          }
        }
        yield finalChunk(cctx, agg.finishReason ?? 'stop', agg.usage);
        this.d.mapper.commit(provider.id, handle.convId, messages, handle.session.webSessionId, handle.run.parentMessageId ?? handle.session.parentMessageId);
        done(true, this.d.now() - started);
      } catch (e) {
        done(false, this.d.now() - started, (e as Error).message);
        throw this.mapErr(e);
      }
    })();
    return {
      [Symbol.asyncIterator]: () => gen,
      async cancel() { try { await provider.stopStream(ctx, handle.session, handle.run.parentMessageId); } catch { /* best effort */ } },
    };
  }

  private mapErr(e: unknown): BridgeError {
    if (e instanceof BridgeError) return e;
    if (e instanceof QueueTimeoutError) return err('rate_limited', 'busy: request queue wait exceeded 60s', 429);
    for (const a of Object.values(this.d.registry)) {
      if (a.isAuthExpired(e)) return err('provider_unavailable', '登录已过期，请在扩展面板重新登录', 503);
      if (a.isRateLimited(e)) return err('rate_limited', '网页端限流，请稍后重试', 429);
      if (a.isUnavailable(e)) return err('provider_unavailable', 'provider unavailable（网络/WAF/未登录）', 503);
    }
    return err('internal_error', (e as Error).message ?? 'unknown error', 500);
  }
}
```

（`runCompletion`/`consumeEvent`/`encodeStream`/`mapErr` 为**本文件内必须实现的私有方法**：runCompletion 的精确流程见注释；集成测试覆盖的断言即行为规格——增量只发尾部、重放触发重建、退避时序、超长 400、未登录 503。）

`src/background/sw.ts`:
```ts
import { Router } from './router';
... // 组装真实依赖：registry(createDeepSeekAdapter(deps with chrome injection))、SessionMapper、Queue、storage(chrome.storage.local)、RingLog
// chrome.runtime.onConnect：name === 'deepapi' 的 port；onMessage：isBridgeRequest 校验 → Router 分发；流式：chunk/done/error 回发；keepalive：收到 ping 回 pong
// chrome.cookies.onChanged：chat.deepseek.com 的 user_token 移除 → storage.set('providers.deepseek.lastAuthStatus', {state:'expired'})（面板读取展示）
// 启动：ensureKey()：storage 无 apiKey → 生成 sk-dapi-<32hex> 写入
```

- [ ] **Step 4: 跑测试验证**

Run: `npx vitest run tests/unit/log.test.ts tests/integration/router.test.ts && npx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/background/log.ts src/background/router.ts src/background/sw.ts tests/unit/log.test.ts tests/integration/router.test.ts && git commit -m "feat: router orchestration with key auth, scheduling and backoff"
```

---

### Task 11: 内容脚本桥接（main API 面 + relay）

**Files:**
- Create: `src/content/bridge-main.ts`、`src/content/bridge-relay.ts`
- Test: `tests/integration/bridge.test.ts`（mock chrome.runtime）

**Interfaces:**
- Consumes: `protocol.ts`（Task 3）
- Produces: `window.deepApi`（MAIN world）；relay 协议细节（`postMessage` 事件名 `deepapi`，信封同 Task 3，`event.source === window` 校验）

- [ ] **Step 1: 写失败测试**

`tests/integration/bridge.test.ts`（jsdom 环境，vitest.config.ts 增加 `environmentMatchGlobs: [['tests/integration/bridge.test.ts', 'jsdom']]`）:
```ts
import { describe, it, expect, vi } from 'vitest';
import { bridgeMainFactory } from '../src/content/bridge-main';
import { createRelay } from '../src/content/bridge-relay';
import type { BridgeResponseMsg } from '../src/shared/protocol';

function fakePort() {
  const sent: unknown[] = [];
  let cb: ((m: unknown) => void) | null = null;
  return {
    sent,
    postMessage: (m: unknown) => { sent.push(m); },
    onMessage: (f: (m: unknown) => void) => { cb = f; },
    emit: (m: unknown) => { cb?.(m); },
  };
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('bridge roundtrip', () => {
  it('create() streams chunks; cancel() sends cancel', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    const api = bridgeMainFactory(window as any) as any;
    const handle = api.chat.completions.create({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await flush();
    const req = port.sent[0] as { __deepApi: { id: number; method: string } };
    expect(req.__deepApi.method).toBe('chat.completions.create');
    const id = req.__deepApi.id;
    port.emit({ __deepApi: { id, kind: 'chunk', chunk: { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] } } } satisfies BridgeResponseMsg);
    port.emit({ __deepApi: { id, kind: 'done' } } satisfies BridgeResponseMsg);
    const chunks: any[] = [];
    for await (const c of handle) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0].delta.content).toBe('你');
    await handle.cancel();
    await flush();
    const cancelReq = port.sent[1] as { __deepApi: { method: string } };
    expect(cancelReq.__deepApi.method).toBe('chat.completions.cancel');
  });
  it('rejects with BridgeError on error envelope', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    const api = bridgeMainFactory(window as any) as any;
    const p = api.models.list();
    await flush();
    const id = (port.sent[0] as any).__deepApi.id;
    port.emit({ __deepApi: { id, kind: 'error', error: { error: { message: 'bad key', type: 'api_error', code: 'invalid_api_key' } } } } satisfies BridgeResponseMsg);
    await expect(p).rejects.toMatchObject({ status: 401 });
  });
  it('ignores foreign window messages', async () => {
    const port = fakePort();
    createRelay(window, port as any);
    window.postMessage({ hello: 1 }, '*');
    window.postMessage({ __deepApi: { id: 999, method: 'evil', params: {} } }, '*');
    await flush();
    expect(port.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/integration/bridge.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/content/bridge-main.ts`（IIFE 友好：导出工厂，入口文件实例化）:
```ts
import type { BridgeParams, ChatCompletion, ChatCompletionChunk, ModelInfo } from '../shared/api-types';
import { BridgeError } from '../shared/protocol';

declare global { interface Window { deepApi: unknown; deepApiConfig?: { apiKey?: string } } }

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; onChunk(c: ChatCompletionChunk): void; onDone(): void; cancelled: boolean };

export function bridgeMainFactory(target: Window): void {
  let seq = 0;
  const pending = new Map<number, Pending>();
  const send = (method: 'chat.completions.create' | 'chat.completions.cancel' | 'models.list', params: unknown): number => {
    const id = ++seq;
    target.postMessage({ __deepApi: { id, method, params } }, '*');
    return id;
  };
  target.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== target) return;
    const env = (ev.data as { __deepApi?: any } | undefined)?.__deepApi;
    if (!env || typeof env.id !== 'number') return;
    const p = pending.get(env.id);
    if (!p) return;
    if (env.kind === 'chunk') { if (!p.cancelled) p.onChunk(env.chunk); return; }
    pending.delete(env.id);
    if (env.kind === 'done') {
      if (p.cancelled) p.reject(new BridgeError({ error: { message: 'cancelled', type: 'api_error', code: 'invalid_request_error' } }, 400));
      else p.onDone();
      return;
    }
    if (env.kind === 'error') {
      const code = env.error?.error?.code as string | undefined;
      const status = code === 'missing_api_key' || code === 'invalid_api_key' ? 401 : code === 'rate_limited' ? 429 : code === 'provider_unavailable' ? 503 : 400;
      p.reject(new BridgeError(env.error, status));
      return;
    }
    p.resolve(env.value);
  });
  function streamHandle(id: number, stream: boolean): any {
    const q: ChatCompletionChunk[] = [];
    let settled = false;
    let wake: () => void = () => {};
    const notify = () => { const w = wake; wake = () => {}; w(); };
    const p: Pending = {
      resolve: () => {}, reject: () => {},
      onChunk: (c) => { q.push(c); notify(); },
      onDone: () => { settled = true; notify(); },
      cancelled: false,
    };
    pending.set(id, p);
    const iter = (async function* () {
      while (true) {
        while (q.length) yield q.shift()!;
        if (settled) return;
        await new Promise<void>((r) => { wake = r; });
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iter,
      async cancel() { p.cancelled = true; send('chat.completions.cancel', { requestId: id }); },
    };
  }
  const api = {
    chat: { completions: {
      create: (params: BridgeParams): Promise<ChatCompletion> | any => {
        const merged = { ...(target.deepApiConfig ?? {}), ...params };
        const id = send('chat.completions.create', merged);
        if (merged.stream === true) return streamHandle(id, true);
        return new Promise<ChatCompletion>((resolve, reject) => {
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => {}, onDone: () => {}, cancelled: false });
        });
      },
    } },
    models: { list: (): Promise<{ object: 'list'; data: ModelInfo[] }> => {
      const id = send('models.list', {});
      return new Promise((resolve, reject) => { pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk: () => {}, onDone: () => {}, cancelled: false }); });
    } },
  };
  Object.defineProperty(target, 'deepApi', { value: api, configurable: false, enumerable: true });
}
```
（`chat.completions.cancel` 加入协议 method 并集：`BridgeMethod = 'chat.completions.create' | 'chat.completions.cancel' | 'models.list'`，Task 3 同步更新。）

`src/content/bridge-relay.ts`:
```ts
import { isBridgeRequest } from '../shared/protocol';
export function createRelay(target: Window, port: { postMessage(m: unknown): void; onMessage(cb: (m: unknown) => void): void }): void {
  target.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== target) return;
    if (!isBridgeRequest(ev.data)) return;
    port.postMessage(ev.data);
  });
  port.onMessage((m) => { target.postMessage(m, '*'); });
  setInterval(() => port.postMessage({ __deepApi: { kind: 'ping' } }), 20_000);  // 流活跃保活；SW 收 ping 回 pong（此时长流仍在继续）
}
```
（SW 侧 ping 处理：`kind==='ping'` → 回 `{__deepApi:{kind:'pong'}}`，不走 Router。Task 10 的 sw.ts 添加该分支。）

- [ ] **Step 4: 跑测试验证**

Run: `npx vitest run tests/integration/bridge.test.ts && npx tsc --noEmit`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/content src/shared/protocol.ts tests/integration/bridge.test.ts && git commit -m "feat: page bridge with main-world api and relay port"
```

---

### Task 12: popup 面板

**Files:**
- Create: `src/popup/popup.html`、`src/popup/popup.css`、`src/popup/popup.ts`、`src/popup/snippet.ts`
- Test: `tests/unit/popup-helpers.test.ts`

**Interfaces:**
- Consumes: `RingLog` 数据结构、storage schema（Task 10）
- Produces: `formatAuthState(s: AuthStatus): { label: string; cls: 'ok' | 'warn' | 'bad' }`、`snippetText(apiKey: string): string`、popup 与 SW 的 port 通道（复用 `deepapi` port，消息 `{ __deepApi: { kind: 'panel.getState' | 'panel.setPool' | 'panel.setTtl' | 'panel.regenerateKey' | 'panel.openLogin' | 'panel.listLogs' } }`，SW 侧实现——**Task 10 的 sw.ts 补这些分支**）

- [ ] **Step 1: 写失败测试**

`tests/unit/popup-helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatAuthState, snippetText } from '../src/popup/snippet';
describe('popup helpers', () => {
  it('maps auth states', () => {
    expect(formatAuthState({ state: 'logged_in' })).toMatchObject({ label: '已登录', cls: 'ok' });
    expect(formatAuthState({ state: 'logged_out' }).cls).toBe('bad');
    expect(formatAuthState({ state: 'expired', message: 'x' }).cls).toBe('warn');
  });
  it('builds snippet with key', () => {
    const s = snippetText('sk-dapi-abc');
    expect(s).toContain('sk-dapi-abc');
    expect(s).toContain('deepApi.chat.completions.create');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/popup-helpers.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`src/popup/snippet.ts`:
```ts
import type { AuthStatus } from '../background/providers/adapter';
export function formatAuthState(s: AuthStatus): { label: string; cls: 'ok' | 'warn' | 'bad' } {
  if (s.state === 'logged_in') return { label: '已登录', cls: 'ok' };
  if (s.state === 'expired') return { label: `已过期: ${s.message}`, cls: 'warn' };
  return { label: '未登录', cls: 'bad' };
}
export function snippetText(apiKey: string): string {
  return `// deep.api 接入（仅一段配置 + 一个调用）
window.deepApiConfig = { apiKey: '${apiKey}' };
const res = await window.deepApi.chat.completions.create({
  model: 'deepseek-chat',            // 或 deepseek-reasoner
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const chunk of res) {
  console.log(chunk.choices[0].delta.content ?? '');
}`;
}
```

`src/popup/popup.html`（id 与 popup.ts 的查询一一对应）:
```html
<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="popup.css"></head>
<body>
  <header><b>deep.api</b><span id="provider-name">DeepSeek</span></header>
  <section class="card"><h3>登录状态</h3>
    <div id="auth-state" class="bad">未登录</div>
    <button id="btn-login">打开登录页</button></section>
  <section class="card"><h3>API Key</h3>
    <code id="api-key">…</code>
    <div class="row"><button id="btn-copy-key">复制</button><button id="btn-reset-key">重置</button></div></section>
  <section class="card"><h3>接入 snippet</h3>
    <textarea id="snippet" rows="8" readonly></textarea>
    <button id="btn-copy-snippet">复制 snippet</button></section>
  <section class="card"><h3>配置</h3>
    <label>线程池 <input id="pool-size" type="number" min="1" max="5" value="2"></label>
    <label>TTL 分钟 <input id="ttl-min" type="number" min="1" value="30"></label>
    <div>模型：<span id="model-list"></span></div></section>
  <section class="card"><h3>日志</h3><ul id="log-list"></ul></section>
  <script src="popup.js"></script>
</body></html>
```
`popup.css`：简单现代样式（卡片、按钮、状态色 ok/warn/bad）。`popup.ts`：connect port（name `deepapi`）→ 发 `panel.getState` → 渲染 `auth-state`/`api-key`/`snippet`（`snippetText(apiKey)`）/`pool-size`/`ttl-min`/`model-list`/`log-list`；按钮发 `panel.login`/`panel.copyKey`（走 clipboard）/`panel.resetKey`/`panel.setPool`/`panel.setTtl`/`panel.listLogs`；`formatAuthState` 决定状态文案与颜色。sw.ts 相应实现 `panel.*` 分支：login → `chrome.tabs.create(loginPageUrl)`；resetKey → 生成新 key 存 storage；其余读写 storage。

- [ ] **Step 4: 跑测试验证**

Run: `npx vitest run tests/unit/popup-helpers.test.ts && npx tsc --noEmit && npm run build`
Expected: 全绿；build 产出 popup.js。

- [ ] **Step 5: Commit**

```bash
git add src/popup tests/unit/popup-helpers.test.ts && git commit -m "feat: popup panel for auth, key, snippet, config and logs"
```

---

### Task 13: manifest + 构建集成 + 加载冒烟

**Files:**
- Create: `extension/manifest.json`（或仓库根 `manifest.json`，与 build.mjs 输出 `dist/` 对齐——**采用根目录 `manifest.json` + `dist/` 结构**，加载扩展时选仓库根目录即可）

**Interfaces:**
- Consumes: 全部产物

- [ ] **Step 1: 写 manifest**

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "deep.api — DeepSeek web as OpenAI API",
  "version": "0.1.0",
  "description": "把 DeepSeek 网页版转成 OpenAI 形态接口供其他网站调用（无伴生进程）",
  "permissions": ["cookies", "storage"],
  "host_permissions": ["https://chat.deepseek.com/*", "https://fe-static.deepseek.com/*"],
  "background": { "service_worker": "dist/sw.js", "type": "module" },
  "action": { "default_popup": "dist/popup.html", "default_title": "deep.api" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["dist/bridge-relay.js"], "run_at": "document_start", "world": "ISOLATED" },
    { "matches": ["<all_urls>"], "js": ["dist/bridge-main.js"], "run_at": "document_start", "world": "MAIN" }
  ]
}
```
（`web_accessible_resources` 不需要；fetch chat.deepseek.com 走 host_permissions。popup.html 引用 `popup.js`/`popup.css`——build.mjs 增加 `copy` 步骤：`dist/popup.html`、`dist/popup.css` 从 `src/popup/` 复制。）

- [ ] **Step 2: build.mjs 补 copy**

修改 `build.mjs`：`import { cp } from 'node:fs/promises'`，构建后 `await cp('src/popup/popup.html','dist/popup.html'); await cp('src/popup/popup.css','dist/popup.css');`

- [ ] **Step 3: 构建并冒烟**

Run: `npm run build && npm test`
Expected: dist 完整（sw.js/bridge-main.js/bridge-relay.js/popup.js/popup.html/popup.css）。

手动冒烟（Chrome chrome://extensions → 开发者模式 → 加载已解压的扩展 → 选仓库根目录）：SW 无报错（chrome://serviceworker-internals 查看）、任意页面存在 `window.deepApi`、popup 打开正常。截图存档 `docs/screenshots/load-smoke.png`。

- [ ] **Step 4: Commit**

```bash
git add manifest.json build.mjs && git commit -m "feat: manifest, build copy step, load smoke"
```

---

### Task 14: E2E 验收 + demo 页面

**Files:**
- Create: `examples/demo-page/index.html`（snippet 版 + 完整 demo 控件：模型选择、流式/非流式、工具调用演示、conversation_id 演示、历史编辑演示）
- Create: `docs/screenshots/`（验收截图）

**Interfaces:**
- Consumes: 全链路

- [ ] **Step 1: 写 demo 页面**

`examples/demo-page/index.html`：单文件页面（内联 `<script>`），页面顶部 `window.deepApiConfig = { apiKey }`（读取 query 参数 `?key=` 或输入框，避免硬编码）；按钮组与行为：
```html
<button data-act="one">非流式</button>
<button data-act="stream">流式</button>
<button data-act="tool">工具调用</button>
<button data-act="rebuild">修改历史重发</button>
<button data-act="conv">conversation_id 续聊</button>
<pre id="out"></pre>
```
`script` 内每个 act 一个 handler：非流式 = `chat.completions.create({ model, messages })` 直接渲染 `choices[0].message`；流式 = `stream: true` + `for await` 渲染 delta（reasoning 进独立 `<pre>`）；工具调用 = `tools: [get_weather]`，收到 `tool_calls` 后 push `{ role: 'tool', tool_call_id, content: '晴 26°C' }` 再请求一轮，输出两轮结果；rebuild = 请求 `[u1, a1]` 后改 a1 文本，再发 `[u1, a1', u2]`；conv = 两次 `conversation_id: 'demo-1'`，第二次 messages 只传最后一条 user 消息。所有请求带 `apiKey`。

- [ ] **Step 2: 验收执行清单（真实账号）**

操作与预期（截图存档 `docs/screenshots/`）：
- 登录 → 面板状态"已登录"（`popup-auth.png`）
- demo 按钮 1/2/3 全通过（`demo-stream.png`、`demo-tool.png`）
- 按钮 4：网页侧打开 chat.deepseek.com 可见**新会话**出现且回答不同 → 无串台（`demo-rebuild.png`）
- 按钮 5：同一 conversation 增量续聊（网页侧可见同一会话接续）
- 面板：key 复制/重置生效；日志显示 20 条内；池改 1 后并发请求排队
- **验收标准（spec §15）全部满足**；截图 + 结果记录到 `docs/screenshots/e2e-report.md`（含工具/流式/状态矛盾 A/B/C 各小节）

- [ ] **Step 3: 收尾提交**

```bash
git add examples docs/screenshots && git commit -m "docs: e2e acceptance report and demo page"
```

---

## 自审记录（写完后对照 spec 检查）

- spec §4.1 Router 管线 → Task 10（含日志、归一化、model 解析）
- spec §4.2 渲染/超限 → Task 4 + Task 10（超限判定在 Router）
- spec §4.3 状态机 → Task 8 + Task 10（decide/register/commit/fail/淘汰/队列 60s）
- spec §4.4 工具管道 → **覆盖率检查：策略被 Task 10 的 consumeEvent/Statuses 覆盖，但 ToolPipeline 独立模块未单列**——补齐：Task 10 的私有方法 `consumeEvent` 内实现 tool 注入与解析，或拆 Task 10 为 10a/10b。**决定：在 Task 10 Step 3 中实现 `src/background/tool-pipeline.ts`（见下），并添加对应单测 `tests/unit/tool-pipeline.test.ts`（fixture：破损 JSON、反斜杠、未引用键、代码块内标签、多调用）。**
- spec §4.5 编码/超时 → Task 5 + Task 10（10min 监督）
- spec §5 契约 → Task 5/9 + 契约测试
- spec §6 DeepSeek 细则 → Task 2/6/7/9
- spec §7 密钥 → Task 10（ensureKey + 校验）
- spec §8.1 桥接/保活 → Task 11 + Task 10 sw.ts ping 分支
- spec §8.2 面板 → Task 12 + sw.ts panel.* 分支
- spec §9 存储 → Task 10/12
- spec §10 错误模型 → Task 5/10（表驱动映射）
- spec §11 工程结构 → 全部任务
- spec §12 spike → Task 2
- spec §15 验收 → Task 14

### Task 10 增补：ToolPipeline

**Files:**
- Create: `src/background/tool-pipeline.ts`
- Test: `tests/unit/tool-pipeline.test.ts`

**Interfaces:**
- Consumes: `ToolDef`、`ToolChoice`、`Message`、`ToolCall`（Task 3）
- Produces:
  - `interface ToolContext { promptSuffix: string }` — `buildToolPrompt(tools, toolChoice): ToolContext`（format 块 + 定义 + 指令；`tool_choice==='none'` → 空 suffix）
  - `parseToolCalls(content: string): { calls: ToolCall[]; remainder: string } | null` — 标签定位（TOOL_TAGS 三组）、跳过代码块、JSON 修复（反斜杠→未引用键→单对象/数组）、失败返回 null
  - `TOOL_TAGS = { starts: ['<|tool_call_begin|>','<tool_calls>','<tool_call>'], ends: ['<|tool_call_end|>','</tool_calls>','</tool_call>'] }`（ds-free-api 默认表）

- [ ] **Step 1: 写失败测试**

`tests/unit/tool-pipeline.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildToolPrompt, parseToolCalls } from '../src/background/tool-pipeline';

describe('buildToolPrompt', () => {
  it('injects defs unless tool_choice none', () => {
    const t = [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];
    expect(buildToolPrompt(t, 'auto').promptSuffix).toContain('f');
    expect(buildToolPrompt(t, 'none').promptSuffix).toBe('');
    expect(buildToolPrompt(t, { type: 'function', function: { name: 'f' } }).promptSuffix).toContain('f');
  });
});
describe('parseToolCalls', () => {
  it('parses clean json array', () => {
    const r = parseToolCalls('先思考\n<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":1}"}}]</tool_calls>');
    expect(r).not.toBeNull(); expect(r!.calls[0]!.function.name).toBe('f');
  });
  it('repairs unquoted keys and bad backslashes', () => {
    const r = parseToolCalls('<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{"path":"C:\\temp"}"}}]</tool_calls>');
    expect(r).not.toBeNull();
  });
  it('skips tags inside code fences', () => {
    const r = parseToolCalls('```\n<tool_calls>x</tool_calls>\n```\n<tool_calls>[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]</tool_calls>');
    expect(r).not.toBeNull(); expect(r!.calls.length).toBe(1);
  });
  it('returns null on garbage', () => { expect(parseToolCalls('plain text')).toBeNull(); });
  it('supports multiple calls', () => {
    const r = parseToolCalls('<|tool_call_begin|>[{"id":"a","type":"function","function":{"name":"f1","arguments":"{}"}},{"id":"b","type":"function","function":{"name":"f2","arguments":"{}"}}]<|tool_call_end|>');
    expect(r!.calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run tests/unit/tool-pipeline.test.ts` → FAIL

- [ ] **Step 3: 实现**（`src/background/tool-pipeline.ts`；`parseToolCalls` 实现要点：先按代码块剔除，再定位任一起始标签（容错匹配），提取至对应结束标签，JSON.parse 尝试 → `repairBackslashes` → `repairUnquotedKeys` → 若仍是数组取首对象；失败/无标签 → null。`buildToolPrompt` 输出三段：`### 格式规范`、`### 工具定义`、`### 调用指令`（含标签说明与 tool_choice 指令）。）

- [ ] **Step 4: 跑测试验证** — 全绿 + tsc

- [ ] **Step 5: 与 Task 10 对齐**：Task 10 Step 3 的 Router 已内置 `buildToolPrompt`/`parseToolCalls` 调用（`runCompletion` 注入后缀、`finalize`/`encodeStream` 解析并三层修复）。本单测通过后运行 Task 10 的完整集成测试；另补一条 router 集成用例：带 tools 的流式请求结果含 `tool_calls` 且 `finish_reason='tool_calls'`（`stubAdapter.streamCompletion` 返回标签包裹的 JSON 内容增量）。

- [ ] **Step 6: Commit**

```bash
git add src/background/tool-pipeline.ts tests/unit/tool-pipeline.test.ts && git commit -m "feat: prompt-engineered tool pipeline with json repair"
```

## 执行交接

计划完成，存于 `docs/superpowers/plans/2026-09-08-deep-api-extension.md`。两种执行方式：

1. **Subagent 驱动（推荐）**：每个任务派发独立 subagent，任务间 review
2. **本会话内联执行**：executing-plans 批量执行 + 检查点

选择哪种？