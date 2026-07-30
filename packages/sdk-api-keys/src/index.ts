export * as server from './server';
export * as types from './models/apiKey.model';
export { migrationsDir } from './db';

export * from './services/apiKeyService';
export * from './services/applicationService';
export * from './services/credentialService';
export {
  startKeyCacheInvalidation,
  stopKeyCache,
  cacheEvict,
  cacheClear,
  cacheSize,
  flushUsed,
} from './services/keyCache';
export { consume, rateLimitHeaders } from './services/rateLimitService';
export type { RateLimitDecision } from './services/rateLimitService';
export { meterKeyUsage, setUsageReporter } from './services/usageMeter';
export type { KeyUsageEvent, UsageReporter } from './services/usageMeter';

export { scopeForRequest, scopeSatisfied, singularise } from './middleware/scope';
export type { ScopeRequest } from './middleware/scope';

export { requireApiKey, attachApiKey } from './middleware/apiKeyAuth';
export type { RequireApiKeyOptions } from './middleware/apiKeyAuth';
export {
  requireAuthOrApiKey,
  authOrAnyApiKey,
  requireAuthOrApiKeyForDomain,
} from './middleware/authOrApiKey';
export type { RequireAuthOrApiKeyOptions } from './middleware/authOrApiKey';

export type {
  ApiKeyRecord,
  ApiKeyStatus,
  ApplicationRecord,
  ApplicationStatus,
  CreateApplicationInput,
  Environment,
  HashAlg,
  IssueApiKeyInput,
  IssueApiKeyResult,
} from './models/apiKey.model';

/**
 * Re-exported deliberately, and load-bearing beyond documentation.
 *
 * A package that swaps sdk-identity's `requireAuth` for one of the guards above
 * stops importing sdk-identity directly, which would drop that package's
 * `declare module 'fastify' { FastifyRequest.auth }` augmentation out of the
 * TypeScript program — handlers still reading `req.auth` then fail to compile
 * with "Property 'auth' does not exist". This explicit re-export puts a real
 * reference to sdk-identity in our emitted `.d.ts`, so the augmentation travels
 * with the guard that populates it.
 */
export type { SixLayerJwtClaims } from '@projexlight/sdk-identity';
