// src/background/relay-recovery.ts — 扩展重载/更新后的 relay 自动恢复（feat/relay-auto-recovery）。
//
// 背景：扩展 reload/update 时 Chrome 销毁所有已开页面里旧 content script 的上下文，驻留的
// bridge-relay 变孤儿（connect 永远抛 "Extension context invalidated"，2026-09-15 起终态停机），
// 桥断开后只能靠用户手动刷新每个页面来恢复。而 MAIN world 的 bridge-main 不依赖扩展上下文、
// 重载后仍然存活，死的只有 ISOLATED world 的 relay（纯转发、无状态）——所以只需把新的
// bridge-relay.js 注回各标签页：新 relay 接管转发（孤儿让位逻辑见 bridge-relay.ts startRelay），
// 桥即免刷新自动恢复。
//
// 权限说明：executeScript 要求宿主权限（manifest content_scripts 匹配模式不算数，官方文档明确）。
// 本扩展 content_scripts 本就是 <all_urls>（产品目标是对任意网站暴露 window.deepApi），
// 故 host_permissions 同步放宽为 <all_urls>，不引入新的能力类别。
// chrome:// 等不可注入页 executeScript 会 reject：单 tab 失败只记日志，不阻塞其余 tab。

export interface RecoverableTab { id?: number }

export interface RelayRecoveryDeps {
  queryTabs(q: { url: string[] }): Promise<RecoverableTab[]>;
  executeScript(injection: { target: { tabId: number }; files: string[]; allFrames?: boolean }): Promise<unknown>;
  log?(msg: string): void;
}

export function createRelayRecovery(deps: RelayRecoveryDeps): () => Promise<void> {
  return async function recoverRelays(): Promise<void> {
    // 只查 http/https：与可注入范围一致（chrome:// / 扩展页等注入必失败，不浪费调用）
    const tabs = await deps.queryTabs({ url: ['http://*/*', 'https://*/*'] });
    let injected = 0;
    let failed = 0;
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        // 不带 allFrames：与 manifest content_scripts（默认仅顶层 frame）保持一致
        await deps.executeScript({ target: { tabId: tab.id }, files: ['bridge-relay.js'] });
        injected++;
      } catch (e) {
        failed++;
        deps.log?.(`[deep.api sw] relay recovery: tab ${tab.id} inject failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    deps.log?.(`[deep.api sw] relay recovery: injected ${injected}/${tabs.length} tab(s), ${failed} failed`);
  };
}
