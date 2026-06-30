import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, resolveSession } from '@projexlight/design-system/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';

/**
 * Workspace auth gate. The workspace serves public marketing pages AND the
 * authenticated builder surfaces, so we protect only the latter — the matcher
 * below lists the authenticated route prefixes. Unauthenticated requests to a
 * protected route are redirected to /login with a returnTo.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token, API_BASE);
  if (!user) {
    // Clone nextUrl so the portal's basePath (/workspace) is preserved — a bare
    // new URL('/login') would resolve to the host root and hit the gateway (404).
    // returnTo carries the full public path (basePath + pathname) so the post-
    // login redirect routes back through nginx to this portal.
    const loginUrl = req.nextUrl.clone();
    const returnTo = (req.nextUrl.basePath || '') + req.nextUrl.pathname;
    loginUrl.search = '';
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('returnTo', returnTo);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Only the authenticated builder surfaces; marketing/landing pages stay public.
  matcher: ['/dashboard/:path*', '/admin/:path*', '/build/:path*', '/features/:path*', '/profile/:path*'],
};
