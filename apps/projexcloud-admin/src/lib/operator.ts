import { hasRole, type SessionUser } from '@projexlight/design-system/auth';

/**
 * Edge-safe (no Node/React APIs) so both middleware.ts and server components can
 * share ONE definition of "is this a ProjexCloud platform operator?".
 *
 * Admin ops-token management is platform-staff-only. A tenant admin, tenant
 * developer, or customer/app-user session must NEVER be treated as an operator,
 * even though it authenticates against the same gateway.
 */

/** Role name that designates a ProjexCloud platform operator. */
export const PLATFORM_OPERATOR_ROLE = process.env.PLATFORM_OPERATOR_ROLE || 'platform-operator';

/**
 * True iff the session belongs to a ProjexCloud platform operator. Two sources:
 *   1. carries the PLATFORM_OPERATOR_ROLE (once role/persona data is populated), OR
 *   2. their email is in PLATFORM_OPERATOR_EMAILS (comma-separated) — the bootstrap
 *      allowlist that identifies ops staff until the role system lands.
 *
 * FAIL-CLOSED: with no role and no allowlist match, the answer is `false`. If
 * PLATFORM_OPERATOR_EMAILS is unset AND no user carries the role, NO ONE is an
 * operator — set at least one of them before using the ops-token console.
 */
export function isPlatformOperator(user: SessionUser | null): boolean {
  if (!user) return false;
  if (hasRole(user, PLATFORM_OPERATOR_ROLE)) return true;
  const allow = (process.env.PLATFORM_OPERATOR_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!user.email && allow.includes(user.email.toLowerCase());
}
