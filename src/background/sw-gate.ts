// src/background/sw-gate.ts — bridge 入口 token 门禁的纯函数版（便于单测）。
//
// 2026-10-01（fix/auth-end-to-end）：把 token 门禁下沉到 provider 维度。ChatGPT provider 已在
// registry 里，但既有的 `if (!token) 503 '未登录 chat.deepseek.com'` 把只登录了 ChatGPT 的用户
// 一起拦死（chat.completions.create / models.list 都进不去）。
//
// 门禁规则（与 sw.ts line ~400 一致，仅当**深先**需要时才检查 token）：
//   - chat.completions.create → 解析 params.model 到哪个 provider；命中 deepseek 才需要 token。
//     chatgpt 模型直接放行；缺 model 走原行为（router 抛 400，但 gate 仍按深先要求）。
//   - chat.completions.cancel / models.list / auth.requested / auth.sync → 不需要 token。
//
// 注：DeepSeek 既有的判定顺序与 503 文案**保留不变**——仅放宽 chatgpt 路径的 token 要求。

import type { ProviderAdapter, ProviderId } from './providers/adapter';

/** 桥接请求的最小形状（sw.ts 监听器内已用同样字段）。 */
export interface BridgeEnvLike {
  method: string;
  params?: unknown;
}

/**
 * 该请求是否需要 DeepSeek token。返回 false 表示不需要任何 token（chatgpt / 列表 / 取消等）。
 * 仅当返回 true 时，sw.ts 才会检查 token；非真时直接放行（token 字段留给 router.create 时
 * 传 ''，因为 chatgpt adapter 不读 token，deepseek adapter 在 chatgpt 路径根本不被调用）。
 */
export function needsDeepSeekToken(env: BridgeEnvLike, registry: Record<ProviderId, ProviderAdapter>): boolean {
  if (env.method !== 'chat.completions.create') return false;
  const params = env.params as { model?: unknown } | undefined;
  if (!params || typeof params.model !== 'string') {
    // 缺 model 由 router 抛 400，但 token 检查行为**保持原顺序**——不放松已有判定。
    return true;
  }
  // 解析 model → 命中 deepseek 才要求 token；其他 provider 都不要求。
  for (const a of Object.values(registry)) {
    if (a.id === 'deepseek' && a.resolveModel(params.model)) return true;
  }
  return false;
}