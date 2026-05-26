/**
 * Hosted-MCP auth (FR-MCP-3). Accepts EITHER:
 *   - `Authorization: Bearer <sixlayer-jwt>`  (preferred — full claims)
 *   - `x-projex-api-key: <key>`               (per PRD; resolved via the
 *     apiKeyResolver callback wired by index.ts to sdk-api-keys.verifyKey)
 *
 * When `apiKeyResolver` is not wired (dev mode), x-projex-api-key returns
 * a synthetic tenant scoped from the key prefix so local end-to-end tests
 * still work without a DB pool.
 */

import { verifyJwt, type SixLayerJwtClaims } from '@projexlight/sdk-identity';
import type { RegistryMcpConfig } from './config';
import type { IncomingHttpHeaders } from 'node:http';

export interface TenantContext {
  sub: string;
  tenant_id: string | null;
  org_id: string | null;
  email?: string;
  /** 'jwt' = Bearer, 'api-key' = x-projex-api-key; 'none' = auth disabled. */
  auth_method: 'jwt' | 'api-key' | 'none';
}

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/** Caller-provided lookup. Returns the tenant context the key resolves to, or null if revoked / unknown. */
export type ApiKeyResolver = (key: string) => Promise<TenantContext | null>;

export interface ExtractTenantOptions {
  apiKeyResolver?: ApiKeyResolver;
}

export async function extractTenantContext(
  headers: IncomingHttpHeaders,
  cfg: RegistryMcpConfig,
  opts: ExtractTenantOptions = {},
): Promise<TenantContext> {
  if (cfg.authMode === 'disabled') {
    return { sub: 'anonymous-dev', tenant_id: null, org_id: null, auth_method: 'none' };
  }

  const apiKey = pickHeader(headers, 'x-projex-api-key');
  if (apiKey) {
    if (opts.apiKeyResolver) {
      const resolved = await opts.apiKeyResolver(apiKey);
      if (!resolved) throw new AuthError(401, 'invalid or revoked api key');
      return { ...resolved, auth_method: 'api-key' };
    }
    // Dev fallback: synthesize a tenant from the key prefix. Keys in dev are
    // shaped `pk_<tenant_short>_<rand>`; production must wire apiKeyResolver.
    const m = /^pk_([a-z0-9-]+)_/i.exec(apiKey);
    return {
      sub: `apikey:${apiKey.slice(0, 12)}`,
      tenant_id: m ? m[1] : null,
      org_id: null,
      auth_method: 'api-key',
    };
  }

  const authHeader = pickHeader(headers, 'authorization');
  if (!authHeader) {
    throw new AuthError(401, 'missing Authorization header or x-projex-api-key');
  }
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) throw new AuthError(401, 'expected Bearer token');
  let claims: SixLayerJwtClaims;
  try {
    claims = verifyJwt(m[1]);
  } catch (e) {
    throw new AuthError(401, `invalid token: ${(e as Error).message}`);
  }
  return {
    sub: claims.sub,
    tenant_id: claims.tenant_id ?? null,
    org_id: claims.org_id ?? null,
    email: claims.email,
    auth_method: 'jwt',
  };
}

function pickHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
