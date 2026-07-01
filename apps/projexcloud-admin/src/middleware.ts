import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, resolveSession } from '@projexlight/design-system/auth';
import { isPlatformOperator } from './lib/operator';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';

/**
 * Platform Admin (console) auth gate. Every operator route requires an
 * authenticated session (resolved against the gateway); unauthenticated
 * requests are redirected to /login. This portal is operator-only — the
 * platform-operator persona check is layered on once that role lands; until
 * then it enforces authentication so the console is never anonymously reachable.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token, API_BASE);
  if (!user) {
    // Clone nextUrl so the portal's basePath (/console) is preserved — a bare
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

  // /security/* manages the platform-wide admin ops token and is PLATFORM-
  // OPERATOR-ONLY. Fail-closed: a tenant admin, developer, or customer session
  // that authenticates here is still rejected (403) unless it is a ProjexCloud
  // platform operator (PLATFORM_OPERATOR_ROLE or PLATFORM_OPERATOR_EMAILS).
  if (req.nextUrl.pathname.startsWith('/security') && !isPlatformOperator(user)) {
    return new NextResponse('Forbidden: platform-operator access required', { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'],
};
