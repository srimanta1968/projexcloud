import { AdminLoginForm } from '@projexlight/design-system';

// Render per-request so returnTo from the middleware redirect is always live.
export const dynamic = 'force-dynamic';

/**
 * /login — sign-in for the Platform Admin (operator) console. The auth
 * middleware redirects unauthenticated requests here with ?returnTo=<path>;
 * this console is operator-only, so only platform staff should sign in.
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams?: { returnTo?: string };
}): JSX.Element {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Platform Admin — Sign in</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Operator access only. Sign in with your ProjexCloud platform credentials.
      </p>
      <AdminLoginForm returnTo={searchParams?.returnTo} />
    </div>
  );
}
