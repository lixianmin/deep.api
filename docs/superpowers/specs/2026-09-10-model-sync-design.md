# Model Catalog Sync — chat.deepseek.com 模型同步

**日期**：2026-09-10
**状态**：草案，待 user review
**触发**：用户报"DeepSeek 官方把三模型合并"（实际是误会——API 仍三个 ID：flash/pro/vision-exp），同时要求"deep.api 每次打开时同步模型列表，避免脱节"

---

## 1. 目标

deep.api 的 `client.ts MODELS` 当前是 hardcoded（写死三个模型 ID + 元数据）。当 DeepSeek 官方：
- 增加新模型
- 重命名模型
- 修改模型参数（thinking default / limit chars / capabilities）

→ deep.api 必须发版才能跟进，**用户在发版间隔期看到过时的模型列表 + 错误的 thinking 默认值 + 错误的 limitChars**。

**目标**：当用户访问 chat.deepseek.com 网页时，deep.api 通过 content script 抓取页面上的**真实模型选择下拉内容**，缓存到 `chrome.storage.local`，deep.api 启动时优先用最新缓存（回退到内置 hardcode）。

---

## 2. 约束（必须知道的现实）

按 §0.3 不编造——以下约束从已调研的事实出发：

| 约束 | 来源 |
|---|---|
| `chat.deepseek.com/api/v0/models` **不存在** | 已枚举所有 v0 端点（completion / upload / session / edit / pow / login / fetch_files）—— 没有 models 端点 |
| DeepSeek 官方 `/v1/models` 需 API key | 实测返回 `Authentication Fails (governor)` —— deep.api 当前用 web cookie，没 API key |
| `chat.deepseek.com` 有 CloudFront WAF | SW 直 fetch 返回 202 + challenge.js——SW 不能绕 |
| `api-docs.deepseek.com/quick_start/pricing` 可爬但非结构化 | markdown 文档里模型版本号（Flash-0731 / Pro-0813）有，但解析脆弱 |
| **只有 content script 在 chat.deepseek.com 页面上下文里能访问完整 DOM**（带 cookie + browser fingerprint 过 WAF） | 用户登录态 + content script 的 world = MAIN |

**结论**：deep.api 同步模型**只能靠用户在 chat.deepseek.com 浏览时**抓页面 DOM。deep.api 独立打开时（没人在 chat.deepseek.com）拿不到。

---

## 3. 设计

### 3.1 架构

```
┌─ chat.deepseek.com 页面上下文 ────────────────────┐
│                                                    │
│   React SPA: 模型选择下拉                          │
│   (Ant Design select / 自定义 dropdown)            │
│                                                    │
│   ┌── content script: models-sync.ts ─────────┐   │
│   │ 1. waitForModelSelector()                 │   │
│   │ 2. extractOptions() → [{label, value, ...}]│   │
│   │ 3. observer.onChange → 重抓               │   │
│   │ 4. send via chrome.runtime.sendMessage    │   │
│   └────────────────────┬────────────────────────┘   │
└────────────────────────┼────────────────────────────┘
                         │  { kind: 'models-catalog',
                         │    source: 'chat.deepseek.com',
                         │    capturedAt: <ts>,
                         │    models: [{label, value}] }
                         ▼
┌─ deep.api SW 上下文 ──────────────────────────────┐
│                                                    │
│   chrome.runtime.onMessage                         │
│     → 写 chrome.storage.local.modelsCatalog        │
│     → notify in-memory registry（可选）           │
│                                                    │
│   client.ts getModels() 改成 async：              │
│     → 先查 storage → 回退到内置 MODELS            │
│                                                    │
│   router.models.list() 返回最新 storage 内容       │
│                                                    │
│   Debug 页 Chat tab 模型 select 用最新列表        │
└────────────────────────────────────────────────────┘
```

### 3.2 新文件 / 改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/content/models-sync.ts` | **新** | content script：在 chat.deepseek.com 抓模型下拉 |
| `src/background/models-sync.ts` | **新** | SW 侧：监听消息 + 写 storage + 提供 getModelsCatalog API |
| `src/background/providers/deepseek/client.ts` | 改 | `MODELS` 保留作为 hardcode fallback；导出 `async getModelsCatalog()` 优先 storage |
| `src/background/router.ts` | 改 | `models.list()` 用最新 storage 内容 |
| `extension/manifest.json` | 改 | 加 content script（matches: `https://chat.deepseek.com/*`，run_at: `document_idle`）—— host_permissions 已有 |
| `src/debug/tabs/chat.ts` | 改 | 模型 select 用最新 catalog（已 async，无需大改） |

### 3.3 DOM 选择器策略（关键不确定点）

DeepSeek UI 模型选择下拉的 DOM 结构未知。content script 用**多重 fallback + 渐进启发**：

```typescript
async function waitForModelSelector(): Promise<HTMLElement> {
  // 多个候选 selector，按优先级试
  const candidates = [
    // 1. 标准 HTML select（罕见但最稳）
    'select[aria-label*="model" i]',
    'select[aria-label*="模型" i]',
    // 2. ARIA combobox（Ant Design）
    '[role="combobox"][aria-label*="model" i]',
    '[role="combobox"][aria-label*="模型" i]',
    // 3. Ant Design Select
    '.ant-select:has(.ant-select-selection-item)',
    // 4. class 含 model
    '[class*="model-select" i]',
    '[class*="modelSelect"]',
    '[data-testid*="model" i]',
    // 5. 终极兜底：找任何包含 "deepseek-v4" 字串的可见 button
    'button:has-text("DeepSeek")', // jsdom 不支持，但真浏览器 querySelector 不行
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  throw new Error('model selector not found');
}
```

**关键设计**：content script **不假设 DOM 结构**——只抓 **用户实际点击后看到的选项列表**（触发下拉打开后再抓 `<option>` / `[role="option"]`）。

简化路径：

```2
async function extractModelOptions(): Promise<Array<{label: string, value: string}> {
  // 点击下拉按钮 → 等 options 浮层出现 → 抓 [role="option"] 全部 text + data-value
  const trigger = await waitForModelSelector();
  trigger.click();
  await sleep(200); // 等 React 重渲染
  const options = Array.from(document.querySelectorAll('[role="option"], .ant-select-item-option'))
    .map(o => ({
      label: (o.textContent || '').trim(),
      // value 不一定能拿到（如 "deepseek-v4-flash"），label "DeepSeek V4 Flash"
    }));
  // 关闭下拉（按 ESC 或再点触发器）
  return options;
}
```

**最简**——只抓 label（用户可见名），value 用字符串匹配到 deep.api 的 model ID：

```3
function labelToModelId(label: string): string {
  // "DeepSeek V4 Flash" → "deepseek-v4-flash"
  // "DeepSeek V4 Pro" → "deepseek-v4-pro"
  // "DeepSeek V4 Flash Vision Exp" → "deepseek-v4-flash-vision-exp"
  return label.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^(deepseek-?)?/, 'deepseek-')
    .replace(/-exp(eriment(al)?)?$/, '-exp')
    .replace(/-vision-exp(eriment(al)?)?$/, '-vision-exp');
}
```

**但**：label→id 映射是 fragile 的。**更稳妥**：deep.api 拿到 label 后，**只更新显示名**，model ID 仍用内置 hardcode。新增模型时（label 在内置没有对应项）→ 加个"未知模型"提示，**仍让用户用内置 ID**。

### 3.4 数据结构

```ts
// chrome.storage.local key
type ModelsCatalog = {
  source: 'chat.deepseek.com';
  capturedAt: number;          // Date.now()
  models: Array<{
    id?: string;               // label→id 映射结果（best effort）
    label: string;             // 用户看到的名字（如 "DeepSeek V4 Flash"）
    value?: string;            // DOM data-value（若有）
  }>;
};

// getModelsCatalog 返回合并结果：内置 MODELS 用 ID + 来自 catalog 的最新 label
type MergedModel = {
  id: string;
  description: string;          // 来自 catalog 的 label，fallback 到内置
  modelType: 'default' | 'expert' | 'vision';
  thinking: boolean;
  limitChars: number;
  // 新增元数据
  capturedAt?: number;
  source?: string;
};
```

### 3.5 缓存策略

- **TTL**：catalog 7 天有效（`capturedAt + 7d > Date.now()` 才用）
- **存储位置**：`chrome.storage.local.modelsCatalog`
- **刷新触发**：用户每次开 chat.deepseek.com → content script 抓一次 → 发消息 → SW 写 storage
- **失败回退**：catalog 不存在 / 过期 / 解析失败 → 用内置 MODELS

### 3.6 跨域消息协议

```ts
// content → SW
chrome.runtime.sendMessage({
  kind: 'models-catalog:update',
  models: [
    { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
    { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
    { label: 'DeepSeek V4 Flash Vision Exp', value: 'deepseek-v4-flash-vision-exp' },
  ],
});

// SW onMessage
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.kind === 'models-catalog:update') {
    chrome.storage.local.set({
      modelsCatalog: {
        source: 'chat.deepseek.com',
        capturedAt: Date.now(),
        models: msg.models,
      },
    });
    sendResponse({ ok: true });
  }
  return true; // keep channel for async sendResponse
});
```

---

## 4. 测试策略

### 4.1 单元测试（content script DOM 解析）

`tests/unit/models-sync.test.ts`（jsdom）：
- mock DOM with 已知下拉结构 → 验证 `extractModelOptions` 输出正确
- 测试 label→id 映射函数
- 测试 trigger click + options 出现流程

### 4.2 单元测试（SW storage 处理）

`tests/unit/models-sync-sw.test.ts`：
- mock `chrome.runtime.onMessage` → 验证 storage 写入
- TTL 过期判断
- 与内置 MODELS 合并逻辑

### 4.3 端到端验证（用户测试）

用户开 chat.deepseek.com → DevTools Console 应看到 content script log：`[models-sync] captured 3 models: ...` → 然后开 deep.api Debug 页 → 模型 select 应显示最新 label + deep.api 内置 ID + 元数据。

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DeepSeek UI 改版 → selector 失效 → 抓不到 | 多重 selector fallback + 用户报告一次后修 selector；catalog 失败时回退到内置 |
| 用户**没开 chat.deepseek.com** → catalog 从来没更新过 | 用内置 MODELS；显示 staleness 提示（capturedAt 距今 > 7 天） |
| 多个模型 label 形似（"V4 Flash" vs "V4 Flash Plus"） | 显示完整 label 不缩写；label→id 映射只 best-effort，不强求 |
| Content script 跑频 / 性能 | 只在 chat.deepseek.com 跑 + document_idle + 用户点击下拉才抓 |
| 隐私：content script 在 chat.deepseek.com 能读所有 DOM | deep.api 现有 bridge-main 已在该域 MAIN world 注入；新增 scriptsync 只读特定 DOM，不发外部 |

---

## 6. 不做（v1 范围外）

- ❌ **自动按 catalog 删除内置模型**——只做"扩充 display label"，不删 deep.api 内置项
- ❌ **PR/价格/limitChars 从官方拉**——limitChars / thinking default 是 deep.api 自己决策（spec 行为），不跟 DeepSeek 官方
- ❌ **跨域 fallback 到 pricing markdown 页**——markdown 解析脆弱，留 v2
- ❌ **每 N 小时主动刷新**——必须用户开 chat.deepseek.com 才同步（约束 §2）

---

## 7. 实现顺序

1. spec review（用户拍板）
2. worktree：实现 content script + SW + storage + tests（按 TDD）
3. 用户开 chat.deepseek.com 实测：DevTools Console 看 log 抓到的 models
4. 如有 selector 问题：根据实际 DOM 调 selector
5. merge + bump v0.1.85

---

## 8. 与"图片上传失败"的并行

图片上传失败诊断（用户等 SW console 证据）独立 worktree 进行，**不影响**本 spec 实现。