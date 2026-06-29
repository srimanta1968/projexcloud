import { cookies } from 'next/headers';
import { SESSION_COOKIE, resolveSession, type SessionUser } from '@projexlight/design-system/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';

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
