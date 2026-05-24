import type { ProviderId, CompletionRequest, CompletionResponse, StreamChunk } from '@projexlight/contracts';

/**
 * Provider adapter abstraction (FR-AGW-1).
 *
 * Each upstream LLM provider ships an adapter implementing this interface.
 * Adapters are registered at boot (api-gateway) similarly to sdk-payment's
 * Stripe adapter — the runtime is provider-agnostic and treats every
 * adapter the same way.
 *
 * Real Anthropic / OpenAI / Gemini / Bedrock adapters live in their own
 * subpackages (sdk-ai-gateway-anthropic, etc.) and are registered via
 * {@link registerProvider}. The runtime here is pure dispatch + bookkeeping.
 */

export interface ProviderAdapter {
  readonly provider_id: ProviderId;
  /** Stateless completion call. Throws on network/4xx/5xx; caller does retry/circuit. */
  complete(request: CompletionRequest, credential: Buffer): Promise<ProviderCompletionResult>;
  /** Streaming variant; yields token deltas until the provider closes the stream. */
  stream(request: CompletionRequest, credential: Buffer): AsyncIterable<StreamChunk>;
}

export interface ProviderCompletionResult {
  /** Final assistant output text. */
  output: string;
  /** Any tool calls the model wants the runtime to dispatch. */
  tool_calls: NonNullable<CompletionResponse['tool_calls']>;
  tokens_in: number;
  tokens_out: number;
  /** Vendor cost in USD (eight decimal places). */
  provider_cost: number;
  /** Optional Langfuse trace id when the adapter calls Langfuse directly. */
  langfuse_trace_id?: string;
  finish_reason: CompletionResponse['finish_reason'];
}

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
