import { AdminLoginForm } from '@projexlight/design-system';

// Render per-request so returnTo from the middleware redirect is always live.
export const dynamic = 'force-dynamic';

/**
 * /login — sign-in for the Tenant Admin console. The auth middleware redirects
 * unauthenticated requests here with ?returnTo=<path>; on success we set the
 * session cookie and return the admin to where they were headed.
 */
export default function LoginPage({
  searchParams,
}: {
  searchParams?: { returnTo?: string };
}): JSX.Element {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Tenant Admin — Sign in</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Sign in to manage your organization&rsquo;s billing, members and integrations.
      </p>
      <AdminLoginForm returnTo={searchParams?.returnTo} />
    </div>
  );
}
