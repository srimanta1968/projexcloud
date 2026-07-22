'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CurrentUserBadge } from '@projexlight/design-system';

// Marketing + auth routes render their OWN header (MarketingHeader / the auth page shell),
// so the app-shell header must not duplicate it there (that caused two "Sign in" links).
// It DOES show on app/dashboard routes, where it's the primary "back to home" nav.
const OWN_HEADER = new Set([
  '/', '/features', '/pricing', '/security', '/terms', '/privacy', '/dpa',
  '/login', '/register', '/signup', '/verify-email', '/customers', '/investors',
]);

export function AppHeader(): JSX.Element | null {
  const pathname = usePathname() || '/';
  if (OWN_HEADER.has(pathname)) return null;

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-5 py-3">
      <Link href="/" className="font-bold">ProjexCloud Workspace</Link>
      <CurrentUserBadge className="ml-auto" loginPath={`${base}/login`} />
    </header>
  );
}
