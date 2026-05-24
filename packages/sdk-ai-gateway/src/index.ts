/**
 * @projexlight/sdk-ai-gateway — public surface.
 *
 * Phase P6A · Wave W6 first half. Multi-provider LLM access with per-tenant
 * routing, PII redaction, provider-cost capture, Langfuse trace integration,
 * budget enforcement delegated to sdk-meter, per-agent kill-switch via
 * sdk-feature-flags.
 */
export { migrationsDir } from './db';
export * as server from './server';

// LLM provider credential bootstrap (I-3 / TK-3305).
export { bootstrapLLMCredentials } from './services/credentialBootstrap';
export type { BootstrapResult } from './services/credentialBootstrap';

// Provider adapter registry (FR-AGW-1) — TK-3289.
export {
  registerProvider,
  getProvider,
  listRegisteredProviders,
  clearProviderRegistry,
} from './services/providerAdapter';
export type { ProviderAdapter, ProviderCompletionResult } from './services/providerAdapter';

// Routing engine + circuit breaker (FR-AGW-2, FR-AGW-9) — TK-3289.
export {
  resolveRoute,
  isCircuitOpen,
  recordProviderSuccess,
  recordProviderFailure,
  withRetry,
} from './services/routingEngine';
export type { RouteDecision, RetryOptions } from './services/routingEngine';

// PII redactor (FR-AGW-3) — TK-3290.
export { redactPrompt, invalidateRedactionCache } from './services/piiRedactor';
export type { RedactResult } from './services/piiRedactor';

// Completion service (FR-AGW-1..9 / AC-1) — TK-3289 service body + TK-3290 REST.
export { complete, stream } from './services/completionService';
