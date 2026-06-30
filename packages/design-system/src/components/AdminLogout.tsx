'use client';

import { useEffect } from 'react';
import { SESSION_COOKIE } from '../auth/session';

export interface AdminLogoutProps {
  /** Where to land after sign-out. Defaults to '/login'. */
  redirectTo?: string;
}

/**
 * Clears the `projexlight.session` cookie the portal middleware reads and
 * bounces to /login. Mirrors AdminLoginForm (which sets the same cookie
 * client-side). Server-side session deny-listing (sdk-identity) is the
 * operator's concern; this clears the local copy so the next request is
 * unauthenticated and the middleware redirects to sign-in.
 *
 * Used by the tenant-admin and projexcloud-admin /logout pages.
 */
export function AdminLogout({ redirectTo = '/login' }: AdminLogoutProps): JSX.Element {
  useEffect(() => {
    // Expire the cookie (same path/SameSite it was written with).
    document.cookie = `${SESSION_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
    window.location.assign(redirectTo);
  }, [redirectTo]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm text-muted-foreground">Signing you out…</p>
    </main>
  );
}
