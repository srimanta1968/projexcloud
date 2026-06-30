import { AdminLogout } from '@projexlight/design-system';

// Always render per-request; never serve a cached sign-out.
export const dynamic = 'force-dynamic';

/**
 * /logout — clears the Tenant Admin session cookie and returns to /login.
 */
export default function LogoutPage(): JSX.Element {
  return <AdminLogout redirectTo="/login" />;
}
