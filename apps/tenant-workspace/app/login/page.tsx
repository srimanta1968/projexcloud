'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LoginForm from '../../components/LoginForm';

/**
 * /login — returning-user sign-in. On success, lands on /dashboard which
 * reads the persisted JWT and renders the appropriate workspace shell.
 */
export default function LoginPage(): JSX.Element {
  const router = useRouter();

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '60px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Sign in</h1>
      <p style={{ color: '#5a6573' }}>
        Welcome back. Sign in with the email + password you used on signup.
      </p>

      <LoginForm onSuccess={() => router.push('/dashboard')} />

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, fontSize: 14 }}>
        <Link href="/signup">Create a workspace</Link>
        <Link href="/register">I was invited</Link>
      </div>

      <p style={{ marginTop: 40, fontSize: 13, color: '#7a8597' }}>
        Tenant admins manage their workspace at{' '}
        <a href="http://localhost:3200">localhost:3200</a>. Platform operators run at{' '}
        <a href="http://localhost:3100">localhost:3100</a>.
      </p>
    </main>
  );
}
