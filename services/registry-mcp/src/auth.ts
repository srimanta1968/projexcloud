import { verifyJwt, type SixLayerJwtClaims } from '@projexlight/sdk-identity';
import type { RegistryMcpConfig } from './config';

export interface TenantContext {
  sub: string;
  tenant_id: string | null;
  org_id: string | null;
  email?: string;
}

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export function extractTenantContext(
  authHeader: string | undefined,
  cfg: RegistryMcpConfig,
): TenantContext {
  if (cfg.authMode === 'disabled') {
    return { sub: 'anonymous-dev', tenant_id: null, org_id: null };
  }
  if (!authHeader) throw new AuthError(401, 'missing Authorization header');
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
  };
}
