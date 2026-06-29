/**
 * Edge-safe session helpers shared by every portal's `middleware.ts`.
 *
 * No React and no Node-only APIs, so these are usable from Next.js middleware
 * (edge runtime). The portal session token travels in the `projexlight.session`
 * cookie; we resolve it against the gateway's `GET /api/userinfo` — the single
 * source of truth — instead of verifying the JWT locally, so no signing secret
 * is ever shared with the web tier.
 */

export const SESSION_COOKIE = 'projexlight.session';

export interface SessionUser {
  sub: string;
  person_id: string;
  email?: string;
  display_name?: string;
  avatar?: string;
  roles: string[];
  persona?: string | null;
}

/**
 * Resolves a bearer token to the current user via the gateway userinfo
 * endpoint. Returns null for any missing/invalid/expired token or network
 * failure (fail-closed — the caller redirects to login).
 */
export async function resolveSession(token: string | undefined, apiBase: string): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase}/api/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      // Never cache an auth decision.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: SessionUser };
    return json?.data ?? null;
  } catch {
    return null;
  }
}

/** True when the resolved user carries the given role-template id / role name. */
export function hasRole(user: SessionUser | null, role: string): boolean {
  return !!user && Array.isArray(user.roles) && user.roles.includes(role);
}
