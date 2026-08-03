import { cookies } from 'next/headers';
import { SESSION_COOKIE, resolveSession, type SessionUser } from '@projexlight/design-system/auth';
import { isPlatformOperator } from './operator';

// Server-side (middleware / next-headers): runs inside the Next process, so
// localhost is correct here. Port corrected from 3500 -> 4000 to match
// GATEWAY_PORT in .env; the old value pointed at a dead port and failed
// silently. Client-side callers derive the host from window.location
// instead, because the browser is not always on this machine.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || `http://localhost:${process.env.GATEWAY_PORT || 4000}`;

/**
 * Guards a privileged server action: resolves the session cookie against the
 * gateway and throws if there is no authenticated operator. Call this at the
 * TOP of any server action BEFORE the server-held ADMIN_OPS_TOKEN is used, so
 * an unauthenticated invocation produces no side effect.
 *
 * The portal middleware already gates these routes; this is defense-in-depth
 * for the action layer itself (direct server-action POSTs).
 */
export async function requireSession(): Promise<SessionUser> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token, API_BASE);
  if (!user) {
    throw new Error('Unauthorized: a valid operator session is required for this action');
  }
  return user;
}

/**
 * Guards a PLATFORM-OPERATOR-ONLY server action (e.g. admin ops-token mint /
 * revoke). Resolves the session AND asserts platform-operator status, so a
 * tenant admin, developer, or customer session — even a valid one — is
 * rejected. Call this at the TOP of the action, before ADMIN_OPS_TOKEN is used.
 * Fail-closed: see isPlatformOperator().
 */
export async function requirePlatformOperator(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isPlatformOperator(user)) {
    throw new Error(
      'Forbidden: only ProjexCloud platform operators may view or manage admin ops tokens',
    );
  }
  return user;
}
