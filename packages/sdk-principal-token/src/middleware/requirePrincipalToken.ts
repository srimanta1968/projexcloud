import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { PrincipalTokenClaims } from '@projexlight/contracts';
import { PrincipalTokenError, verifyPrincipalToken } from '../services/principalTokenService';

/**
 * P10/E2 — downstream principal-token verification middleware.
 *
 * Verifies the gateway-minted token (iss/aud/exp/signature) and rejects any
 * forwarded user-identity headers as an identity source — services trust ONLY
 * the verified token, never headers a caller can spoof (closes the
 * confused-deputy class).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Verified principal claims, set by requirePrincipalToken. */
    principal?: PrincipalTokenClaims;
  }
}

/**
 * Identity-bearing headers that MUST NOT be trusted as an identity source.
 * They are deleted before verification so no downstream handler can read them.
 */
export const FORWARDED_IDENTITY_HEADERS = [
  'x-identity',
  'x-identity-context',
  'x-user-id',
  'x-person-id',
  'x-tenant-id',
  'x-bu-id',
  'x-persona-id',
  'x-personas',
  'x-scopes',
  'x-roles',
  'x-act-as',
  'x-on-behalf-of',
];

/** Removes forwarded identity headers so they can never be read as identity. */
export function stripForwardedIdentityHeaders(req: FastifyRequest): void {
  const headers = req.headers as Record<string, unknown>;
  for (const h of FORWARDED_IDENTITY_HEADERS) {
    if (h in headers) delete headers[h];
  }
}

function extractBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const [scheme, value] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

export interface RequirePrincipalTokenOptions {
  /** Audience this service expects (aud claim). Required. */
  audience: string;
  issuer?: string;
  /** Optional audit hook invoked on rejection. */
  onReject?: (req: FastifyRequest, reason: string) => void;
}

/**
 * Fastify preHandler that strips forwarded identity headers, then verifies the
 * principal token from `x-principal-token` or `Authorization: Bearer`. On
 * success sets `req.principal`; on failure replies 401 and invokes onReject.
 */
export function requirePrincipalToken(opts: RequirePrincipalTokenOptions): preHandlerHookHandler {
  return async function principalTokenGuard(req, reply): Promise<void> {
    stripForwardedIdentityHeaders(req);
    const headerToken = req.headers['x-principal-token'];
    const raw = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    const token = raw ?? extractBearer(req.headers.authorization);
    if (!token) {
      opts.onReject?.(req, 'missing principal token');
      reply.code(401).send({ error: 'PrincipalTokenRequired' });
      return;
    }
    try {
      req.principal = await verifyPrincipalToken(token, { audience: opts.audience, issuer: opts.issuer });
    } catch (err) {
      const reason = err instanceof PrincipalTokenError ? err.message : 'invalid principal token';
      opts.onReject?.(req, reason);
      reply.code(401).send({ error: 'InvalidPrincipalToken' });
    }
  };
}
