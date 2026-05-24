import type { AgentContext, CompletionRequest, ProviderId } from '@projexlight/contracts';

/**
 * Local-provider preference hook (G-P8-5).
 *
 * On-prem deployments (P8 Variant C) host LLMs in-cluster via Ollama / vLLM
 * and MUST NOT call cloud providers (FR-ONP-5 / FR-ONP-8). sdk-onprem
 * registers a resolver here at boot; sdk-ai-gateway's completionService
 * consults the resolver BEFORE selectRoute() so a local model wins over
 * any platform-default cloud route.
 *
 * sdk-ai-gateway intentionally does NOT depend on sdk-onprem — the
 * direction is sdk-onprem → registers this resolver at boot. Keeps the
 * dep graph one-way and lets cloud deployments skip on-prem entirely.
 */

export interface LocalProviderHit {
  /** Provider id of the registered local adapter (e.g. 'ollama-local'). */
  provider_id: ProviderId;
  /** Model id served by the local backend (e.g. 'llama-3.1-70b-instruct'). */
  model: string;
}

export type LocalProviderResolver = (
  ctx: AgentContext,
  request: CompletionRequest,
) => Promise<LocalProviderHit | null> | LocalProviderHit | null;

let _resolver: LocalProviderResolver = () => null;

export function setLocalProviderResolver(resolver: LocalProviderResolver | null): void {
  _resolver = resolver ?? (() => null);
}

export async function resolveLocalProvider(
  ctx: AgentContext,
  request: CompletionRequest,
): Promise<LocalProviderHit | null> {
  return _resolver(ctx, request);
}

/** Test-only — wipe the resolver. */
export function _resetLocalProviderResolver(): void {
  _resolver = () => null;
}
