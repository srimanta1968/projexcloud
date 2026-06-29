import jwt, { SignOptions } from 'jsonwebtoken';
import { dataService } from '@projexlight/db-runtime';

// Read these at call time, NOT at module load. The gateway loads .env via
// dotenv inside its config module, which is imported AFTER sdk-identity — so a
// module-load-time capture would miss JWT_SECRET from .env and silently fall
// back to the insecure default (the cause of mass 401 "Invalid or expired
// token" failures: the runner signs with the real .env secret, the gateway
// verified with 'change-me-in-prod'). Lazy reads always see the loaded value.
function jwtSecret(): string {
  return process.env.JWT_SECRET || 'change-me-in-prod';
}
function jwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '7d';
}

export type ActorKind = 'human' | 'service' | 'agent' | 'support_impersonator';

/**
 * Six-layer JWT claim set per P2-Identity-Access §5.3. Every claim except
 * `sub` is optional in P1; P2+ writers populate them as data lands.
 */
export interface SixLayerJwtClaims {
  sub: string;
  email?: string;
  /** Human display name (from the L2 profile band), so portals can greet the user without an extra fetch. */
  display_name?: string;
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
  const options: SignOptions = { expiresIn: jwtExpiresIn() as SignOptions['expiresIn'] };
  return jwt.sign(payload as object, jwtSecret(), options);
}

/**
 * Verifies and decodes a JWT. Returns the typed claim set; consumers must
 * narrow to the layer they need.
 */
export function verifyJwt(token: string): SixLayerJwtClaims {
  return jwt.verify(token, jwtSecret()) as SixLayerJwtClaims;
}

/**
 * Builds a six-layer JWT from a verified login + optional tenant context.
 * If `tenant_id` is provided, the matching membership populates bu_id and
 * role_template_id; otherwise the JWT carries only person-level claims.
 */
export interface BuildJwtInput {
  person_id: string;
  email: string;
  display_name?: string;
  tenant_id?: string | null;
  bu_id?: string | null;
  app_id?: string | null;
  admin_pool_index?: string | null;
  app_pool_index?: Record<string, string>;
  projection_version?: number;
  actor_kind?: ActorKind;
  mfa_methods?: string[];
}

export function buildSixLayerClaims(input: BuildJwtInput): SixLayerJwtClaims {
  return {
    sub: input.person_id,
    email: input.email,
    // Omitted from the token when unknown (undefined is dropped by JSON serialization).
    display_name: input.display_name || undefined,
    tenant_id: input.tenant_id ?? null,
    bu_id: input.bu_id ?? null,
    app_id: input.app_id ?? null,
    admin_pool_index: input.admin_pool_index ?? null,
    app_pool_index: input.app_pool_index ?? {},
    projection_version: input.projection_version ?? 0,
    actor: { kind: input.actor_kind ?? 'human' },
    amr: input.mfa_methods ?? ['pwd'],
  };
}

/**
 * FR-IDN-4: best-effort lookup of the current projection_version for the
 * subject+app+tenant tuple. Returns 0 when no projection row exists yet
 * (P2 first-login case) — the policy precomp cache treats version=0 as a
 * forced cache miss so DOWN is safe.
 */
export async function readProjectionVersion(
  person_id: string,
  app_id: string | null | undefined,
  tenant_id: string | null | undefined,
): Promise<number> {
  if (!app_id || !tenant_id) return 0;
  try {
    const row = await dataService.one<{ projection_version: number }>(
      `SELECT projection_version FROM projection.subject_view
        WHERE person_id = $1 AND app_id = $2 AND tenant_id = $3`,
      [person_id, app_id, tenant_id],
    );
    return Number(row?.projection_version ?? 0);
  } catch {
    return 0;
  }
}
