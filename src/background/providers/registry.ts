import type { ProviderAdapter } from './adapter';

export function createRegistry(provider: ProviderAdapter): Record<string, ProviderAdapter> {
  return { [provider.id]: provider };
}
