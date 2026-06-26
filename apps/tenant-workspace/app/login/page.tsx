'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LoginForm from '../../components/LoginForm';
import { AuthShell } from '../../components/AuthShell';
import { TENANT_URL, CONSOLE_URL } from '../../lib/portalLinks';

/**
 * /login — returning-user sign-in. On success, lands on /dashboard which
 * reads the persisted JWT and renders the appropriate workspace shell.
 */
export default function LoginPage(): JSX.Element {
  const router = useRouter();

  return (
    <AuthShell className="max-w-md">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Sign in</h1>
      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        Welcome back. Sign in with the email and password you used at signup.
      </p>

      <LoginForm onSuccess={() => router.push('/dashboard')} />

      <div className="mt-5 flex justify-between text-sm">
        <Link href="/signup" className="text-primary hover:underline">Create a workspace</Link>
        <Link href="/register" className="text-primary hover:underline">I was invited</Link>
      </div>

      <p className="mt-7 text-center text-xs text-muted-foreground">
        Tenant admins manage their workspace in the{' '}
        <a href={TENANT_URL} className="underline">Tenant Admin console</a>. Platform staff use the{' '}
        <a href={CONSOLE_URL} className="underline">Platform Console</a>.
      </p>
    </AuthShell>
  );
}
