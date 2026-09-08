import type { ModelInfo, ProviderAdapter } from './adapter';

export function createRegistry(provider: ProviderAdapter): Record<string, ProviderAdapter> {
  return { [provider.id]: provider };
}

export function listModels(registry: Record<string, ProviderAdapter>): ModelInfo[] {
  return Object.values(registry).flatMap(p => p.models);
}
