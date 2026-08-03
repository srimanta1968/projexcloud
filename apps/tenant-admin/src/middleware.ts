import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, resolveSession } from '@projexlight/design-system/auth';

// Server-side (middleware / next-headers): runs inside the Next process, so
// localhost is correct here. Port corrected from 3500 -> 4000 to match
// GATEWAY_PORT in .env; the old value pointed at a dead port and failed
// silently. Client-side callers derive the host from window.location
// instead, because the browser is not always on this machine.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || `http://localhost:${process.env.GATEWAY_PORT || 4000}`;

/**
 * Tenant Admin auth gate. Every console route requires an authenticated
 * session (resolved against the gateway). Unauthenticated requests are
 * redirected to /login with a returnTo so they land back where they started.
 * Role-scoped gating (tenant-admin) is layered on once role/persona data lands.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token, API_BASE);
  if (!user) {
    // Clone nextUrl so the portal's basePath (/tenant) is preserved — a bare
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
  // Protect everything except the login route, Next internals and static assets.
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'],
};
