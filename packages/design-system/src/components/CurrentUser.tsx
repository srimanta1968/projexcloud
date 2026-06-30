'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The current authenticated user, as resolved by GET /api/userinfo.
 * Mirrors the sdk-identity UserinfoResponse (display name from the L2 profile
 * band, email from the email alias, roles from active memberships).
 */
export interface CurrentUser {
  sub: string;
  person_id: string;
  email?: string;
  display_name?: string;
  avatar?: string;
  roles: string[];
  persona?: string | null;
}

export interface UseUserOptions {
  /** Gateway base URL. Defaults to NEXT_PUBLIC_API_BASE or http://localhost:3500. */
  apiBase?: string;
  /** localStorage key holding the bearer token. Defaults to the workspace key. */
  tokenKey?: string;
}

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';
const DEFAULT_TOKEN_KEY = 'projexlight.auth.token';

export interface UseUserResult {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  signOut: (loginPath?: string) => void;
}

/**
 * Resolves the current user from GET /api/userinfo using the bearer token in
 * localStorage. Returns loading/error states and a signOut helper. Safe during
 * SSR (no-ops until mounted in the browser).
 */
export function useUser(options: UseUserOptions = {}): UseUserResult {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const tokenKey = options.tokenKey ?? DEFAULT_TOKEN_KEY;

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback(
    (loginPath = '/login') => {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(tokenKey);
      // Clear the middleware session cookie (matches SESSION_COOKIE in ./auth).
      document.cookie = 'projexlight.session=; path=/; SameSite=Lax; max-age=0';
      window.location.assign(loginPath);
    },
    [tokenKey],
  );

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (typeof window === 'undefined') return;
      const token = window.localStorage.getItem(tokenKey);
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${apiBase}/api/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const json = (await res.json()) as { data?: CurrentUser };
        if (!cancelled) setUser(json?.data ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, tokenKey]);

  return { user, loading, error, signOut };
}

function initials(name?: string, email?: string): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

export interface CurrentUserBadgeProps extends UseUserOptions {
  /** Where "Sign in"/"Sign out" navigates. Defaults to /login. */
  loginPath?: string;
  className?: string;
}

/**
 * Header/account widget: avatar (image or initials) + display name + primary
 * role + sign-out. Drop `<CurrentUserBadge />` into any portal header. Colours
 * are inherited from the surrounding header so it works on light or dark bars;
 * the avatar uses the brand colour for contrast either way.
 */
export function CurrentUserBadge({
  apiBase,
  tokenKey,
  loginPath = '/login',
  className,
}: CurrentUserBadgeProps): JSX.Element {
  const { user, loading, error, signOut } = useUser({ apiBase, tokenKey });

  if (loading) {
    return (
      <div className={className} aria-busy="true" aria-label="Loading account">
        <span className="inline-block h-8 w-8 animate-pulse rounded-full bg-current opacity-20" />
      </div>
    );
  }

  if (error || !user) {
    return (
      <a href={loginPath} className={`text-sm font-semibold underline ${className ?? ''}`} aria-label="Sign in">
        Sign in
      </a>
    );
  }

  const name = user.display_name || user.email || 'Account';
  const role = user.roles && user.roles.length > 0 ? user.roles[0] : 'Member';

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`} aria-label="Current user">
      {user.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span
          className="grid h-8 w-8 place-items-center rounded-full bg-[#1A51C7] text-xs font-bold text-white"
          aria-hidden="true"
        >
          {initials(user.display_name, user.email)}
        </span>
      )}
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{name}</span>
        <span className="text-[11px] opacity-70">{role}</span>
      </span>
      <button
        type="button"
        onClick={() => signOut(loginPath)}
        className="ml-2 text-xs underline opacity-80 hover:opacity-100"
        aria-label="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}
