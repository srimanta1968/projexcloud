import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export type ActorKind = 'human' | 'service' | 'agent' | 'support_impersonator';

/**
 * Six-layer JWT claim set per P2-Identity-Access §5.3. Every claim except
 * `sub` is optional in P1; P2+ writers populate them as data lands.
 */
export interface SixLayerJwtClaims {
  sub: string;
  email?: string;
  org_id?: string | null;
  app_id?: string | null;
  tenant_id?: string | null;
  bu_id?: string | null;
  parent_tenant_id?: string | null;
  root_tenant_id?: string | null;
  reseller_id?: string | null;
  primary_persona_id?: string | null;
  all_persona_ids?: string[];
  admin_pool_index?: string | null;
  app_pool_index?: Record<string, string>;
  projection_version?: number;
  encounter_id?: string | null;
  actor?: { kind: ActorKind };
  amr?: string[];
}

/**
 * Legacy P1 claim shape — kept for backwards compatibility with the prototype
 * register endpoint. P2 consumers should use SixLayerJwtClaims.
 */
export interface JwtPayload {
  sub: string;
  email: string;
}

/**
 * Signs a JWT with the configured secret and expiry.
 */
export function signJwt(payload: JwtPayload | SixLayerJwtClaims): string {
  const options: SignOptions = { expiresIn: JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign(payload as object, JWT_SECRET, options);
}

/**
 * Verifies and decodes a JWT. Returns the typed claim set; consumers must
 * narrow to the layer they need.
 */
export function verifyJwt(token: string): SixLayerJwtClaims {
  return jwt.verify(token, JWT_SECRET) as SixLayerJwtClaims;
}

/**
 * Builds a six-layer JWT from a verified login + optional tenant context.
 * If `tenant_id` is provided, the matching membership populates bu_id and
 * role_template_id; otherwise the JWT carries only person-level claims.
 */
export interface BuildJwtInput {
  person_id: string;
  email: string;
  tenant_id?: string | null;
  bu_id?: string | null;
  app_id?: string | null;
  admin_pool_index?: string | null;
  app_pool_index?: Record<string, string>;
  actor_kind?: ActorKind;
  mfa_methods?: string[];
}

export function buildSixLayerClaims(input: BuildJwtInput): SixLayerJwtClaims {
  return {
    sub: input.person_id,
    email: input.email,
    tenant_id: input.tenant_id ?? null,
    bu_id: input.bu_id ?? null,
    app_id: input.app_id ?? null,
    admin_pool_index: input.admin_pool_index ?? null,
    app_pool_index: input.app_pool_index ?? {},
    actor: { kind: input.actor_kind ?? 'human' },
    amr: input.mfa_methods ?? ['pwd'],
  };
}
