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
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '60px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#5a6573' }}>Signing you out…</p>
    </main>
  );
}
