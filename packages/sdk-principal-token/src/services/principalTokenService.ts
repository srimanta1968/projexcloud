import jwt, { type JwtHeader } from 'jsonwebtoken';
import type { PrincipalTokenClaims } from '@projexlight/contracts';
import { getActiveSigningKey, listVerificationKeys } from './signingKeyStore';

/**
 * P10/E2 — mint + verify the platform principal token.
 *
 * The gateway mints a signed, audience-bound, short-TTL token from the
 * SERVER-RESOLVED identity context; downstream services verify iss/aud/exp and
 * the signature. Claims derive ONLY from the resolved context — never from
 * request input (closes the confused-deputy class, critique Scenario 5).
 */

/**
 * Structural subset of the resolved IdentityContext the token is minted from.
 * The gateway passes the real IdentityContext (which is structurally
 * compatible); this avoids an SDK dependency on sdk-identity-resolver.
 */
export interface ResolvedPrincipal {
  person_id: string;
  app_id: string;
  tenant_id: string;
  bu_id?: string | null;
  root_tenant_id?: string | null;
  all_persona_ids?: string[];
  primary_persona_id?: string | null;
  effective_scopes?: string[];
  effective_role_closure?: string[];
  projection_version?: number;
  /** P10/E9: gateway-captured context, optional. */
  device_trust?: string;
  network_zone?: string;
  purpose?: string;
}

export interface MintPrincipalTokenOptions {
  /** Target service the token is bound to (aud claim). Required. */
  audience: string;
  /** Token lifetime in seconds. Defaults to PRINCIPAL_TOKEN_TTL_SECONDS or 300 (short). */
  ttlSeconds?: number;
  /** Issuer. Defaults to PRINCIPAL_TOKEN_ISSUER or 'projexcloud-gateway'. */
  issuer?: string;
  /** Actor kind for impersonation/break-glass audit (human/service/agent/...). */
  actorKind?: string;
}

const DEFAULT_TTL_SECONDS = parseInt(process.env.PRINCIPAL_TOKEN_TTL_SECONDS || '300', 10);

function defaultIssuer(): string {
  return process.env.PRINCIPAL_TOKEN_ISSUER || 'projexcloud-gateway';
}

/** Maximum TTL a token can request — bounds the rotation overlap window. */
export const MAX_PRINCIPAL_TOKEN_TTL_SECONDS = parseInt(
  process.env.PRINCIPAL_TOKEN_MAX_TTL_SECONDS || '900',
  10,
);

/**
 * Mints a signed principal token from the resolved context. All claims come
 * from `principal` (server-resolved); the only caller-supplied value is the
 * audience the token is bound to.
 */
export async function mintPrincipalToken(
  principal: ResolvedPrincipal,
  opts: MintPrincipalTokenOptions,
): Promise<string> {
  if (!opts.audience) throw new Error('audience is required to mint an audience-bound principal token');
  const ttl = Math.min(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_PRINCIPAL_TOKEN_TTL_SECONDS);
  const key = await getActiveSigningKey();

  const claims: Omit<PrincipalTokenClaims, 'iat' | 'exp'> = {
    iss: opts.issuer ?? defaultIssuer(),
    aud: opts.audience,
    sub: principal.person_id,
    app_id: principal.app_id,
    tenant_id: principal.tenant_id,
    bu_id: principal.bu_id ?? null,
    root_tenant_id: principal.root_tenant_id ?? null,
    personas: principal.all_persona_ids ?? [],
    primary_persona_id: principal.primary_persona_id ?? null,
    scopes: principal.effective_scopes ?? [],
    roles: principal.effective_role_closure ?? [],
    projection_version: principal.projection_version ?? 0,
    ...(principal.device_trust ? { device_trust: principal.device_trust } : {}),
    ...(principal.network_zone ? { network_zone: principal.network_zone } : {}),
    ...(principal.purpose ? { purpose: principal.purpose } : {}),
    ...(opts.actorKind ? { act: { kind: opts.actorKind } } : {}),
    kid: key.kid,
  };

  return jwt.sign(claims, key.secret, {
    algorithm: 'HS256',
    expiresIn: ttl,
    keyid: key.kid,
  });
}

export class PrincipalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalTokenError';
  }
}

/**
 * Verifies a principal token: signature (over the key matching the header kid,
 * or any key in the rotation overlap window), issuer, audience and expiry.
 * Throws PrincipalTokenError on any failure.
 */
export async function verifyPrincipalToken(
  token: string,
  opts: { audience: string; issuer?: string },
): Promise<PrincipalTokenClaims> {
  const decoded = jwt.decode(token, { complete: true });
  const headerKid = (decoded?.header as JwtHeader | undefined)?.kid;
  const keys = await listVerificationKeys();
  const ordered = headerKid ? [...keys].sort((a) => (a.kid === headerKid ? -1 : 1)) : keys;

  let lastError: Error | null = null;
  for (const key of ordered) {
    try {
      return jwt.verify(token, key.secret, {
        algorithms: ['HS256'],
        audience: opts.audience,
        issuer: opts.issuer ?? defaultIssuer(),
      }) as PrincipalTokenClaims;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw new PrincipalTokenError(
    `principal token verification failed: ${lastError?.message ?? 'no valid signing key'}`,
  );
}
