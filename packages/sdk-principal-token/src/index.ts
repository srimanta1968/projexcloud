/**
 * @projexlight/sdk-principal-token — P10/E2 platform principal token.
 *
 * The gateway mints a signed, audience-bound, short-TTL token from the
 * resolved IdentityContext (mintPrincipalToken); downstream services verify it
 * and reject forwarded identity headers (requirePrincipalToken). Signing keys
 * are rotating, wrapped at rest by a vault-sourced key, and honor an overlap
 * window so rotation never invalidates in-flight tokens.
 */
export {
  mintPrincipalToken,
  verifyPrincipalToken,
  PrincipalTokenError,
  MAX_PRINCIPAL_TOKEN_TTL_SECONDS,
} from './services/principalTokenService';
export type { ResolvedPrincipal, MintPrincipalTokenOptions } from './services/principalTokenService';
export {
  getActiveSigningKey,
  listVerificationKeys,
  rotateSigningKey,
  setWrapKeyProvider,
} from './services/signingKeyStore';
export type { SigningKeyMaterial } from './services/signingKeyStore';
export { startPrincipalKeyRotation } from './services/rotationScheduler';
export type {
  PrincipalKeyRotationConfig,
  PrincipalKeyRotationHandle,
} from './services/rotationScheduler';
export {
  requirePrincipalToken,
  stripForwardedIdentityHeaders,
  FORWARDED_IDENTITY_HEADERS,
} from './middleware/requirePrincipalToken';
export type { RequirePrincipalTokenOptions } from './middleware/requirePrincipalToken';
export { migrationsDir } from './db';
