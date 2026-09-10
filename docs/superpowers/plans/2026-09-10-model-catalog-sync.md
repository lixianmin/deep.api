# Model Catalog Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add chat.deepseek.com DOM scraping to deep.api so the in-extension model list tracks DeepSeek's current model naming, without a manual deep.api release each time DeepSeek updates labels.

**Architecture:** New content script (`src/content/models-sync.ts`) injects into `https://chat.deepseek.com/*` via existing `host_permissions`, scrapes the model selector dropdown, sends the captured labels to the SW. SW writes the catalog into `chrome.storage.local`; client.ts merges it on top of the hardcoded `MODELS` constant. Debug page + Chat tab read the merged catalog.

**Tech Stack:** Chrome MV3 (manifest v3, service worker, content scripts), `chrome.runtime.sendMessage` / `chrome.storage.local`, vitest (jsdom for content script tests, node-mocks for SW tests), TDD.

**Spec:** `docs/superpowers/specs/2026-09-10-model-sync-design.md` — every requirement below traces back to a section of the spec.

---

## Global Constraints

- **Manifest v3, MV3-only**: content scripts must declare `world: "MAIN"` to read SPA-rendered DOM (spec §3.1). Already in `extension/manifest.json`.
- **Backward compat**: hardcoded `MODELS` in `client.ts` remains the source of truth for `id`/`modelType`/`thinking`/`limitChars`. Catalog only enriches `description` (label) and adds `capturedAt` (spec §3.4 / §6).
- **TTL**: catalog 7 days; expired/missing → fall back to hardcoded `MODELS` (spec §3.5).
- **Failure mode**: any DOM/parse/storage failure must NOT break the SW; deep.api must keep working with the hardcoded catalog.
- **Tests must run** with `npm test` from the worktree root; do not introduce new test runners.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/content/models-sync.ts` | CREATE | Content script: scrape model selector, send to SW |
| `src/background/models-sync.ts` | CREATE | SW handler: receive catalog, write to `chrome.storage.local`, expose `getModelsCatalog()` |
| `src/background/providers/deepseek/client.ts` | MODIFY | `MODELS` constant stays; add `getModelsCatalog()` async merge helper |
| `src/background/sw.ts` | MODIFY | Wire content-script message into `models-sync.ts` handler; expose `models.list` (already wired) to read merged catalog |
| `extension/manifest.json` | MODIFY | Add new `content_scripts` entry for `models-sync.js` matching `https://chat.deepseek.com/*` |
| `src/debug/tabs/chat.ts` | MODIFY | Model `<select>` uses merged catalog labels instead of raw `id` |
| `tests/unit/models-sync.test.ts` | CREATE | jsdom unit tests for DOM scrape + label-to-id mapping |
| `tests/unit/models-sync-sw.test.ts` | CREATE | Unit tests for SW `getModelsCatalog()` + storage read/write |
| `tests/integration/router-vision.test.ts` | MODIFY | Add catalog-aware test (model select uses captured label) |
| `tests/debug/tabs/chat.test.ts` | MODIFY | Add assertion: select option text is the captured label (or fallback id) |

---

## Task 1: Content script — DOM scrape + label mapping

**Files:**
- Create: `src/content/models-sync.ts`
- Test: `tests/unit/models-sync.test.ts`

**Interfaces:**
- Consumes: existing `chrome.runtime.sendMessage` API (no new dependencies)
- Produces: exports `extractModelOptions(): Promise<ModelOption[]>`, `labelToModelId(label: string): string | null`, `ModelOption` type

- [ ] **Step 1: Write the failing test** (jsdom)

In `tests/unit/models-sync.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { extractModelOptions, labelToModelId, type ModelOption } from '../../src/content/models-sync';

describe('labelToModelId', () => {
  it('maps "DeepSeek V4 Flash" → "deepseek-v4-flash"', () => {
    expect(labelToModelId('DeepSeek V4 Flash')).toBe('deepseek-v4-flash');
  });
  it('maps "DeepSeek V4 Pro" → "deepseek-v4-pro"', () => {
    expect(labelToModelId('DeepSeek V4 Pro')).toBe('deepseek-v4-pro');
  });
  it('maps "DeepSeek V4 Flash Vision Exp" → "deepseek-v4-flash-vision-exp"', () => {
    expect(labelToModelId('DeepSeek V4 Flash Vision Exp')).toBe('deepseek-v4-flash-vision-exp');
  });
  it('returns null for unknown labels', () => {
    expect(labelToModelId('Some Future Model')).toBeNull();
  });
});

describe('extractModelOptions', () => {
  function mountSelector(html: string) {
    document.body.innerHTML = html;
  }
  it('scrapes [role="option"] children of an open dropdown', async () => {
    mountSelector(`
      <button data-testid="model-trigger">Current</button>
      <div role="listbox">
        <div role="option">DeepSeek V4 Flash</div>
        <div role="option">DeepSeek V4 Pro</div>
        <div role="option">DeepSeek V4 Flash Vision Exp</div>
      </div>
    `);
    const opts = await extractModelOptions();
    expect(opts).toEqual([
      { label: 'DeepSeek V4 Flash' },
      { label: 'DeepSeek V4 Pro' },
      { label: 'DeepSeek V4 Flash Vision Exp' },
    ]);
  });
  it('returns [] when no dropdown present', async () => {
    mountSelector(`<div>nothing relevant</div>`);
    expect(await extractModelOptions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd <worktree>
./node_modules/.bin/vitest run tests/unit/models-sync.test.ts
```
Expected: FAIL with "Cannot find module '../../src/content/models-sync'".

- [ ] **Step 3: Implement `src/content/models-sync.ts`**

```ts
/// <reference lib="dom" />
/** 2026-09-10（feat/models-sync）：chat.deepseek.com 模型选择下拉 DOM 抓取。
 *  spec §3.3 多重 selector fallback + label→id best-effort 映射。
 *  失败/无 DOM 时一律静默返回 []，不抛错（spec §3.5 失败回退）。 */

export interface ModelOption { label: string; value?: string }

const SELECTOR_CANDIDATES = [
  '[role="listbox"] [role="option"]',
  '.ant-select-item-option',
  'li[role="option"]',
  'select option',
] as const;

const LABEL_PATTERNS: Array<{ re: RegExp; id: string }> = [
  { re: /deepseek\s*v4\s*flash\s*vision\s*exp(eriment(al)?)?/i, id: 'deepseek-v4-flash-vision-exp' },
  { re: /deepseek\s*v4\s*pro/i, id: 'deepseek-v4-pro' },
  { re: /deepseek\s*v4\s*flash/i, id: 'deepseek-v4-flash' },
];

export function labelToModelId(label: string): string | null {
  const t = (label || '').trim();
  if (!t) return null;
  for (const { re, id } of LABEL_PATTERNS) {
    if (re.test(t)) return id;
  }
  return null;
}

export async function extractModelOptions(): Promise<ModelOption[]> {
  for (const sel of SELECTOR_CANDIDATES) {
    const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    if (nodes.length === 0) continue;
    return nodes
      .map((n) => ({ label: (n.textContent || '').trim() }))
      .filter((o) => o.label.length > 0);
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content/models-sync.ts tests/unit/models-sync.test.ts
git commit -m "feat(content): models-sync DOM scrape + label→id mapping"
```

---

## Task 2: Content script → SW message wiring

**Files:**
- Modify: `src/content/models-sync.ts`
- Test: `tests/unit/models-sync.test.ts` (extend)

**Interfaces:**
- Consumes: `chrome.runtime.sendMessage` (global, no shim needed in tests with `vi.stubGlobal`)
- Produces: `sendCatalogUpdate(opts: ModelOption[]): void` exported for testability

- [ ] **Step 1: Add failing test for `sendCatalogUpdate`**

Append to `tests/unit/models-sync.test.ts`:
```ts
import { sendCatalogUpdate } from '../../src/content/models-sync';

describe('sendCatalogUpdate', () => {
  it('posts models-catalog:update to chrome.runtime.sendMessage', () => {
    const send = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
    sendCatalogUpdate([{ label: 'DeepSeek V4 Flash' }]);
    expect(send).toHaveBeenCalledWith({
      kind: 'models-catalog:update',
      models: [{ label: 'DeepSeek V4 Flash' }],
    });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync.test.ts
```
Expected: FAIL with "sendCatalogUpdate is not a function".

- [ ] **Step 3: Implement `sendCatalogUpdate`**

Append to `src/content/models-sync.ts`:
```ts
export function sendCatalogUpdate(models: ModelOption[]): void {
  try {
    (globalThis as { chrome?: { runtime?: { sendMessage: (m: unknown) => void } } })
      .chrome?.runtime?.sendMessage({ kind: 'models-catalog:update', models });
  } catch { /* spec §3.5 失败回退：吞掉所有错误 */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/content/models-sync.ts tests/unit/models-sync.test.ts
git commit -m "feat(content): sendCatalogUpdate posts to SW"
```

---

## Task 3: SW handler — storage write + `getModelsCatalog()`

**Files:**
- Create: `src/background/models-sync.ts`
- Test: `tests/unit/models-sync-sw.test.ts`

**Interfaces:**
- Consumes: `chrome.storage.local`, `chrome.runtime.onMessage`
- Produces: `onCatalogUpdate(models)` message handler, `getModelsCatalog()` returning `{ source, capturedAt, models } | null`, `clearCatalog()`

- [ ] **Step 1: Write the failing test**

In `tests/unit/models-sync-sw.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onCatalogUpdate, getModelsCatalog, CATALOG_KEY } from '../../src/background/models-sync';

const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('chrome', {
    storage: { local: { set: (kv: Record<string, unknown>) => { for (const [k, v] of Object.entries(kv)) store.set(k, v); } } },
  });
});

describe('onCatalogUpdate', () => {
  it('writes catalog to chrome.storage.local with source + capturedAt', () => {
    onCatalogUpdate([{ label: 'DeepSeek V4 Flash' }]);
    const cat = store.get(CATALOG_KEY);
    expect(cat).toMatchObject({
      source: 'chat.deepseek.com',
      capturedAt: expect.any(Number),
      models: [{ label: 'DeepSeek V4 Flash' }],
    });
  });
});

describe('getModelsCatalog', () => {
  it('returns null when storage is empty', () => {
    expect(getModelsCatalog()).toBeNull();
  });
  it('returns null when catalog older than 7 days', () => {
    store.set(CATALOG_KEY, { source: 'chat.deepseek.com', capturedAt: Date.now() - 8 * 24 * 3600 * 1000, models: [] });
    expect(getModelsCatalog()).toBeNull();
  });
  it('returns catalog when within 7-day TTL', () => {
    store.set(CATALOG_KEY, { source: 'chat.deepseek.com', capturedAt: Date.now() - 1 * 24 * 3600 * 1000, models: [{ label: 'x' }] });
    expect(getModelsCatalog()).toEqual({
      source: 'chat.deepseek.com',
      capturedAt: expect.any(Number),
      models: [{ label: 'x' }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync-sw.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/background/models-sync.ts`**

```ts
import type { ModelOption } from '../content/models-sync';

export const CATALOG_KEY = 'modelsCatalog';
const TTL_MS = 7 * 24 * 3600 * 1000;
export interface Catalog {
  source: 'chat.deepseek.com';
  capturedAt: number;
  models: ModelOption[];
}

export function onCatalogUpdate(models: ModelOption[]): void {
  const cat: Catalog = { source: 'chat.deepseek.com', capturedAt: Date.now(), models };
  try {
    (globalThis as { chrome?: { storage?: { local?: { set: (kv: Record<string, unknown>) => void } } } })
      .chrome?.storage?.local?.set({ [CATALOG_KEY]: cat });
  } catch { /* spec §3.5 失败回退 */ }
}

export function getModelsCatalog(): Catalog | null {
  try {
    const raw = (globalThis as { __catalog?: Catalog }).__catalog;
    if (!raw || !Array.isArray(raw.models)) return null;
    if (Date.now() - raw.capturedAt > TTL_MS) return null;
    return raw;
  } catch { return null; }
}
```

Note: the test sets a backing `store` Map; `onCatalogUpdate` calls `chrome.storage.local.set` which the test shim writes to that map. `getModelsCatalog` reads from `__catalog` global — to bridge, **update both tests and impl in the next step** so storage is the single source of truth (cleaner).

Replace `__catalog` lookup with a real `chrome.storage.local.get` call (also stubbable in tests):

```ts
export async function getModelsCatalog(): Promise<Catalog | null> {
  return await new Promise<Catalog | null>((resolve) => {
    try {
      (globalThis as { chrome?: { storage?: { local?: { get: (k: string, cb: (kv: Record<string, unknown>) => void) => void } } } })
        .chrome?.storage?.local?.get(CATALOG_KEY, (kv) => {
          const raw = kv[CATALOG_KEY] as Catalog | undefined;
          if (!raw || !Array.isArray(raw.models)) return resolve(null);
          if (Date.now() - raw.capturedAt > TTL_MS) return resolve(null);
          resolve(raw);
        });
    } catch { resolve(null); }
  });
}
```

Update tests to await `getModelsCatalog()` and stub the `get` callback form:
```ts
vi.stubGlobal('chrome', {
  storage: { local: {
    set: (kv) => { for (const [k, v] of Object.entries(kv)) store.set(k, v); },
    get: (k, cb) => { cb({ [k]: store.get(k) }); },
  } },
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync-sw.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/models-sync.ts tests/unit/models-sync-sw.test.ts
git commit -m "feat(background): models-sync storage handler + getModelsCatalog"
```

---

## Task 4: client.ts — merge catalog with hardcoded `MODELS`

**Files:**
- Modify: `src/background/providers/deepseek/client.ts`
- Test: `tests/unit/models-sync-sw.test.ts` (extend) — covers `mergeWithHardcoded`

**Interfaces:**
- Consumes: `getModelsCatalog()` from Task 3, existing `MODELS` constant
- Produces: `mergeWithHardcoded(catalog | null, hardcoded): MergedModel[]` exported

- [ ] **Step 1: Add failing test for `mergeWithHardcoded`**

Append to `tests/unit/models-sync-sw.test.ts`:
```ts
import { mergeWithHardcoded, type MergedModel } from '../../src/background/providers/deepseek/client';

const HARDCODED: MergedModel[] = [
  { id: 'deepseek-v4-flash', modelType: 'default', thinking: true, limitChars: 2621440 },
  { id: 'deepseek-v4-pro', modelType: 'expert', thinking: true, limitChars: 163840 },
  { id: 'deepseek-v4-flash-vision-exp', modelType: 'vision', thinking: true, limitChars: 2621440 },
];

describe('mergeWithHardcoded', () => {
  it('returns hardcoded copy when catalog is null', () => {
    expect(mergeWithHardcoded(null, HARDCODED)).toEqual(HARDCODED);
  });
  it('enriches description + capturedAt from catalog by id match', async () => {
    // 需要 labelToModelId：直接 inline 写
    const cat = { source: 'chat.deepseek.com' as const, capturedAt: 123, models: [
      { label: 'DeepSeek V4 Flash' },  // → deepseek-v4-flash
      { label: 'New Unknown Model' },   // → null
    ] };
    const merged = mergeWithHardcoded(cat, HARDCODED);
    expect(merged[0]).toMatchObject({ id: 'deepseek-v4-flash', description: 'DeepSeek V4 Flash', capturedAt: 123 });
    expect(merged[1].description).toBe('deepseek-v4-pro');  // fallback id
    expect(merged[2].description).toBe('deepseek-v4-flash-vision-exp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync-sw.test.ts
```
Expected: FAIL with "mergeWithHardcoded is not a function".

- [ ] **Step 3: Implement `mergeWithHardcoded` in `client.ts`**

Add to `src/background/providers/deepseek/client.ts` (next to the existing `MODELS` constant):
```ts
import { labelToModelId, type ModelOption } from '../../content/models-sync';

export interface MergedModel {
  id: string;
  description: string;
  modelType: 'default' | 'expert' | 'vision';
  thinking: boolean;
  limitChars: number;
  capturedAt?: number;
  source?: string;
}

/** 2026-09-10（feat/models-sync）：catalog 与 hardcoded 合并——id 匹配则覆盖 description + 加 capturedAt；
 *  不删 hardcoded 项；不引入新 id（spec §6 不做：自动增/删模型）。 */
export function mergeWithHardcoded(
  catalog: { capturedAt: number; models: ModelOption[] } | null,
  hardcoded: MergedModel[],
): MergedModel[] {
  if (!catalog) return hardcoded.map((m) => ({ ...m }));
  const byLabel: Map<string, string> = new Map();
  for (const o of catalog.models) {
    const id = labelToModelId(o.label);
    if (id) byLabel.set(id, o.label);
  }
  return hardcoded.map((m) => byLabel.has(m.id)
    ? { ...m, description: byLabel.get(m.id)!, capturedAt: catalog.capturedAt, source: 'chat.deepseek.com' }
    : { ...m, description: m.id },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/unit/models-sync-sw.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/background/providers/deepseek/client.ts tests/unit/models-sync-sw.test.ts
git commit -m "feat(client): mergeWithHardcoded — catalog enriches description"
```

---

## Task 5: SW wires onMessage → handler + `models.list` returns merged

**Files:**
- Modify: `src/background/sw.ts`
- Test: existing `tests/integration/router-vision.test.ts` (extend) — `models.list` returns merged

**Interfaces:**
- Consumes: `onCatalogUpdate` from Task 3, `mergeWithHardcoded` from Task 4
- Produces: SW `port.onMessage` dispatches `models-catalog:update` → `onCatalogUpdate`; `models.list` returns merged `MergedModel[]`

- [ ] **Step 1: Add failing test for `models.list` returning merged**

Append to `tests/integration/router-vision.test.ts`:
```ts
describe('models.list returns merged catalog when available', () => {
  it('falls back to hardcoded when no catalog', async () => {
    // 现有 router.models() 测试已存在；新加：catalog 存在时 description 来自 catalog
    vi.stubGlobal('chrome', {
      storage: { local: { get: (_k: string, cb: (kv: Record<string, unknown>) => void) => cb({}) } },
    });
    const adapter = makeMockAdapter({});
    const router = makeRouter(adapter);
    const r = await router.models();
    expect(r.data.map((m) => m.description)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (existing behavior)**

```bash
./node_modules/.bin/vitest run tests/integration/router-vision.test.ts
```
Expected: pass (no change yet — baseline).

- [ ] **Step 3: Wire `port.onMessage` `models-catalog:update` in `sw.ts`**

In `src/background/sw.ts`, add inside the `port.onMessage` listener (after the `auth.sync` block):
```ts
import { onCatalogUpdate } from './models-sync';

// …inside port.onMessage.addListener…
if (env.method === 'models-catalog:update') {
  const params = env.params as { models?: { label: string; value?: string }[] };
  if (Array.isArray(params?.models)) onCatalogUpdate(params.models);
  safePost({ __deepApi: { id: env.id, kind: 'done' } } as unknown as BridgeResponseMsg);
  return;
}
```

Then change `models.list` to use `mergeWithHardcoded`:
```ts
import { MODELS as HARDCODED_MODELS, mergeWithHardcoded, type MergedModel } from './providers/deepseek/client';
// …replace existing models.list branch…
} else if (env.method === 'models.list') {
  const cat = await getModelsCatalog();
  const merged: MergedModel[] = mergeWithHardcoded(cat, HARDCODED_MODELS.map((m) => ({
    id: m.id, description: m.id, modelType: m.modelType, thinking: m.thinking, limitChars: m.limitChars,
  })));
  safePost({ __deepApi: { id: env.id, kind: 'result', value: { object: 'list', data: merged as unknown as { id: string; provider: string; description: string }[] } } } as unknown as BridgeResponseMsg);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/integration/router-vision.test.ts
```
Expected: 9 tests pass (3 new + 6 existing).

- [ ] **Step 5: Commit**

```bash
git add src/background/sw.ts tests/integration/router-vision.test.ts
git commit -m "feat(sw): wire catalog update + models.list uses merged"
```

---

## Task 6: manifest.json — register content script

**Files:**
- Modify: `extension/manifest.json`
- (no test — manifest is consumed by Chrome at load time)

**Interfaces:**
- Consumes: existing `host_permissions` (already includes `https://chat.deepseek.com/*`)
- Produces: new `content_scripts` entry for `models-sync.js`

- [ ] **Step 1: Add `models-sync.js` entry**

In `extension/manifest.json`, append to the `content_scripts` array (after the existing two entries):
```json
{
  "matches": [
    "https://chat.deepseek.com/*"
  ],
  "js": [
    "models-sync.js"
  ],
  "run_at": "document_idle",
  "world": "MAIN"
}
```

- [ ] **Step 2: Verify build emits `models-sync.js`**

```bash
cd <worktree>
npm run build
ls -la extension/models-sync.js
```
Expected: file exists and is non-empty.

- [ ] **Step 3: Commit**

```bash
git add extension/manifest.json
git commit -m "chore(manifest): register models-sync content script for chat.deepseek.com"
```

---

## Task 7: Debug page Chat tab — show captured label

**Files:**
- Modify: `src/debug/tabs/chat.ts`
- Test: `tests/debug/tabs/chat.test.ts` (extend)

**Interfaces:**
- Consumes: existing `models.list` API (already returns merged catalog from Task 5)
- Produces: `<option>` text in the model `<select>` is `description` (captured label) instead of `id`

- [ ] **Step 1: Update render test assertion**

In `tests/debug/tabs/chat.test.ts`, find the assertion that model `<option>` text equals `m.id` (existing line near the top of the existing `mountChat` test). Replace with:
```ts
expect(pane.querySelector('[data-chat-model] option')?.textContent).toMatch(/deepseek-v4/);  // either id or captured label
```

- [ ] **Step 2: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/debug/tabs/chat.test.ts
```
Expected: pass (regex matches both id and label).

- [ ] **Step 3: Update `chat.ts` to render `description`**

In `src/debug/tabs/chat.ts`, find the model-list rendering (the `.map((m) => '<option value="...">` line):
```ts
modelSel.innerHTML = (r.data as any[]).map((m: any) =>
  `<option value="${m.id}">${m.description ?? m.id}</option>`).join('');
```
`m.description` is the captured label (or falls back to id if not in catalog).

- [ ] **Step 4: Run test to verify it passes**

```bash
./node_modules/.bin/vitest run tests/debug/tabs/chat.test.ts
```
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/debug/tabs/chat.ts tests/debug/tabs/chat.test.ts
git commit -m "feat(debug): chat tab shows captured model label"
```

---

## Task 8: End-to-end smoke (user-driven, documented in plan)

**Files:** none (manual test in user's browser)

- [ ] **Step 1: Verify build still passes**

```bash
cd <worktree>
./node_modules/.bin/vitest run
npm run build
```
Expected: all tests pass, build succeeds.

- [ ] **Step 2: Merge worktree to main + bump + push**

```bash
cd <main checkout>
git fetch origin
git merge --ff-only feat/models-sync
git push origin main
npm run build
npm run bump
git add manifest.json package.json
git -c user.email=agent@deep.api -c user.name="deep.api agent" commit -m "chore: bump v0.1.85 -> v0.1.86 (model catalog sync)"
git push origin main
```

- [ ] **Step 3: User reloads + opens chat.deepseek.com**

Tell the user:
1. `chrome://extensions/` → remove → load unpacked `/Users/xmli/me/code/deep.api/extension`
2. Open `https://chat.deepseek.com` in Chrome and **click the model selector dropdown once** (so the content script can read the option list)
3. Go to the deep.api Debug page → Chat tab → open the model `<select>` → confirm option text reads "DeepSeek V4 Flash" (or the actual current label), not the raw `deepseek-v4-flash` id

Expected: model labels match what chat.deepseek.com shows. If labels still show raw ids, the content script's selector chain (Task 1) didn't match the live DOM — ask the user to share the actual model dropdown HTML and tighten the selector.

---

## Self-Review

**1. Spec coverage:**
- §3.1 architecture ✓ Task 1 + 3 + 5
- §3.3 DOM selector strategy ✓ Task 1
- §3.4 data structures (`ModelOption`, `Catalog`, `MergedModel`) ✓ Tasks 1, 3, 4
- §3.5 caching strategy (TTL 7d, fallback) ✓ Task 3
- §3.6 cross-domain message protocol ✓ Tasks 2, 5
- §4 test strategy (unit + integration) ✓ Tasks 1, 3, 4, 5, 7
- §5 risk: failures silent, deep.api keeps working ✓ all tasks use try/catch + fallback

**2. Placeholder scan:** no "TBD", "TODO", "implement later", "similar to", or unfilled blocks. Every code block is complete. Every step has either a code snippet, a command, or a file path.

**3. Type consistency:**
- `ModelOption` defined in `src/content/models-sync.ts` (Task 1), imported by Tasks 3 + 4
- `Catalog` defined in `src/background/models-sync.ts` (Task 3), consumed by Task 5
- `MergedModel` defined in `src/background/providers/deepseek/client.ts` (Task 4), consumed by Task 5
- `labelToModelId` defined in `src/content/models-sync.ts` (Task 1), used by Task 4

All cross-task references match. Plan ready for execution.