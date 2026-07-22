'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AuthShell } from '../../components/AuthShell';
import { verifyEmail } from '../../services/authApi';

function VerifyEmailInner(): JSX.Element {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) {
      setState('error');
      return;
    }
    verifyEmail(token)
      .then((r) => {
        setEmail(r.email);
        setState('ok');
      })
      .catch(() => setState('error'));
  }, [token]);

  if (state === 'loading') {
    return (
      <AuthShell>
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Verifying your email…</h1>
        <p className="text-sm text-muted-foreground">One moment while we confirm your address.</p>
      </AuthShell>
    );
  }
  if (state === 'ok') {
    return (
      <AuthShell>
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Email verified ✓</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          <strong className="text-foreground">{email}</strong> is confirmed. You can sign in now.
        </p>
        <Link
          href="/login"
          className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Verification failed</h1>
      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        This verification link is invalid or has expired. Please{' '}
        <Link href="/register" className="text-primary underline">register again</Link> to get a new link.
      </p>
      <Link href="/login" className="text-primary underline">Back to sign in</Link>
    </AuthShell>
  );
}

export default function VerifyEmailPage(): JSX.Element {
  return (
    <Suspense fallback={<AuthShell><h1 className="text-3xl font-bold tracking-tight">Verifying…</h1></AuthShell>}>
      <VerifyEmailInner />
    </Suspense>
  );
}
