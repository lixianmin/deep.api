# Final-Review Fix Wave #1 Report

Status: DONE

Findings addressed:
- (Critical) content script trigger: ADDRESSED
- (Important) dead bridge branch: ADDRESSED
- (Partner request) V4 retired → 1 model: ADDRESSED

Commits: b186478..85d1bf6 (planned: 4 commits)
Test summary: 241/241 pass on full suite (was 237 prior; +3 new trigger tests + adjusted existing)
Files changed:
- `src/content/models-sync.ts` — top-level trigger (start/startWith), chat.deepseek.com guard, labelToModelId pattern updates
- `src/background/sw.ts` — removed dead `port.onMessage` branch for `models-catalog:update`; dropped unused `onCatalogUpdate` import
- `src/background/providers/deepseek/client.ts` — `MODELS` shrunk to 1 entry (`deepseek-flash`); `LIMITS` keeps vision entry as compat layer
- `tests/unit/models-sync-trigger.test.ts` (new) — 3 jsdom tests for trigger
- `tests/unit/models-sync.test.ts` — labelToModelId cases for V4.1
- `tests/unit/models-sync-sw.test.ts` — HARDCODED fixture → 1 entry
- `tests/unit/deepseek-models.test.ts` — V4.1 unified expectations
- `tests/unit/deepseek-client.test.ts` — single chat model expectations
- `tests/unit/deepseek-adapter.test.ts` — single chat model expectations
- `tests/integration/router-vision.test.ts` — mock adapter models → 1 entry
- `vitest.config.ts` — added trigger test to jsdom match
- `docs/superpowers/specs/2026-09-10-model-sync-design.md` — added §9 Deprecation note
- `docs/superpowers/plans/2026-09-10-model-catalog-sync.md` — added Deprecation update section
- `docs/01.memory.md` — added V4.1 Flash lesson

Concerns:
- `labelToModelId` regex was relaxed in the fix (matches "DeepSeek V4.1 Flash" with space + dot). If a future user supplies a label with non-ASCII separators, may mis-match. Not load-bearing.
- `LIMITS` keeps `deepseek-v4-flash-vision-exp` for the vision path because the partner didn't ask about vision and changelog only mentioned chat IDs. If vision also retires, follow-up.

End-to-end manual smoke instructions for partner:
1. reload extension v0.1.86 → 0.1.87
2. open `https://chat.deepseek.com` (must be logged in)
3. click the model selector once — wait ~2s for dropdown to open + poll
4. `chrome://extensions` → DeepSeek API → Service Worker → Console — should see `[deep.api sw]` no errors
5. open deep.api Debug page → Chat tab → model select should show "DeepSeek V4.1 Flash" (or "default") as the single option
6. (Optional) click the model selector again — trigger re-fires; SW console should reflect a second modelsCatalog write
7. (For vision) pick a vision image in the Debug Chat, send — vision pipeline still works (vision model preserved as compat layer)
