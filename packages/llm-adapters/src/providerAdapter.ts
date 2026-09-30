import type { ProviderId, CompletionRequest, CompletionResponse, StreamChunk } from '@projexlight/contracts';

/**
 * Provider adapter contract (FR-AGW-1). Every upstream LLM provider implements it; the
 * adapter is stateless — the caller supplies the credential per call and owns retry,
 * circuit breaking and bookkeeping (sdk-ai-gateway) or turn orchestration (voice-runtime).
 */
export interface ProviderAdapter {
  readonly provider_id: ProviderId;
  /** Stateless completion call. Throws on network/4xx/5xx; caller does retry/circuit. */
  complete(request: CompletionRequest, credential: Buffer): Promise<ProviderCompletionResult>;
  /**
   * Streaming variant; yields token deltas until the provider closes the stream. Returning
   * early from the iteration (break / return()) cancels the HTTP response body, so the
   * provider stops generating — the voice runtime relies on this for barge-in.
   */
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
