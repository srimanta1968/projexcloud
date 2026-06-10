'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { logoutUser } from '../../services/authApi';

/**
 * /logout — clear the persisted token + bounce to /login. Server-side
 * session deny-list (sdk-identity) is the operator's concern; this only
 * clears the local copy.
 */
export default function LogoutPage(): JSX.Element {
  const router = useRouter();
  useEffect(() => {
    logoutUser();
    router.replace('/login');
  }, [router]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-muted-foreground">Signing you out…</p>
    </main>
  );
}
