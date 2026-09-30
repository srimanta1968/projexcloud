import type { ProviderId } from '@projexlight/contracts';
import type { ProviderAdapter } from '@projexlight/llm-adapters';

/**
 * Provider adapter registry (FR-AGW-1).
 *
 * The adapter contract and the real Anthropic / OpenAI / Gemini / Bedrock adapters live in
 * @projexlight/llm-adapters (stateless, no DB — the voice runtime uses them too). They are
 * registered here at boot (api-gateway) via {@link registerProvider}; the gateway is pure
 * dispatch + bookkeeping and treats every adapter the same way.
 */
export type { ProviderAdapter, ProviderCompletionResult } from '@projexlight/llm-adapters';

const adapters = new Map<ProviderId, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  adapters.set(adapter.provider_id, adapter);
}

export function getProvider(provider_id: ProviderId): ProviderAdapter {
  const adapter = adapters.get(provider_id);
  if (!adapter) {
    throw new Error(`[ai-gateway] no adapter registered for provider ${provider_id}`);
  }
  return adapter;
}

export function listRegisteredProviders(): ProviderId[] {
  return Array.from(adapters.keys());
}

/** Test/dev only — wipes the adapter registry. */
export function clearProviderRegistry(): void {
  adapters.clear();
}
