import type { ProviderAdapter } from './adapter';

// 2026-10-01（stage-a2/debt-task2）：变参支持多 provider。
// 重复 id 时后者覆盖前者（Object.fromEntries 语义）。
export function createRegistry(...providers: ProviderAdapter[]): Record<string, ProviderAdapter> {
  return Object.fromEntries(providers.map((p) => [p.id, p]));
}
