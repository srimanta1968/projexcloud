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

// Real provider adapters (VA·E5) and the list-price hook their costs use.
export {
  registerRealProviderAdapters,
  realProviderAdaptersEnabled,
  makeOpenAiCompatibleAdapter,
  OPENAI_COMPATIBLE_BASE_URLS,
  makeAnthropicAdapter,
  makeGeminiAdapter,
  makeBedrockAdapter,
  signV4,
  ProviderHttpError,
} from './services/adapters';
export type { OpenAiCompatibleOptions } from './services/adapters';
export { setModelPriceResolver, providerCost } from './services/modelPricing';
export type { ModelPrice, ModelPriceResolver } from './services/modelPricing';

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

// Tenant BYOK credential bindings — read side, for SDKs that reference a binding by id
// (sdk-voice-agent stack profiles). Never returns the envelope, only binding metadata.
export {
  listTenantCredentials,
  CREDENTIAL_LAYERS,
  CREDENTIAL_PRIORITIES,
  LAYER_PROVIDERS,
  withTenantCredentialKey,
  recordCredentialValidation,
  credentialMaxConcurrency,
  CredentialUnavailableError,
} from './services/tenantCredentialService';
export type {
  TenantCredentialBinding,
  CredentialLayer,
  CredentialPriority,
  ValidationStatus,
  CredentialValidationResult,
} from './services/tenantCredentialService';

// Completion service (FR-AGW-1..9 / AC-1) — TK-3289 service body + TK-3290 REST.
export { complete, stream } from './services/completionService';

// P8 Variant C — local provider preference hook for on-prem deployments.
// sdk-onprem registers a resolver at boot; selectRoute() consults it first.
export {
  setLocalProviderResolver,
  resolveLocalProvider,
  _resetLocalProviderResolver,
} from './services/localProviderResolver';
export type {
  LocalProviderResolver,
  LocalProviderHit,
} from './services/localProviderResolver';
