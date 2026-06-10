'use client';

import Link from 'next/link';
import { useState } from 'react';
import RegisterForm from '../../components/RegisterForm';
import { AuthShell } from '../../components/AuthShell';

/**
 * /register — personal account only (no tenant created). Used by people who
 * were invited to an existing tenant. New customers should use /signup
 * (which creates a person + org + tenant in one flow).
 */
export default function RegisterPage(): JSX.Element {
  const [welcome, setWelcome] = useState<{ userId: string; email: string } | null>(null);

  if (welcome) {
    return (
      <AuthShell className="max-w-xl">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Welcome, {welcome.email}</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          Your user ID is <code className="rounded bg-muted px-1.5 py-0.5">{welcome.userId}</code>.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your personal account is created but you&apos;re not attached to any workspace yet.
          Ask your workspace admin to invite this email, or{' '}
          <Link href="/signup" className="text-primary underline">create your own workspace</Link>.
        </p>
        <p className="mt-6 text-xs text-muted-foreground">
          Already signed in? <Link href="/dashboard" className="text-primary underline">Go to your workspace dashboard</Link>.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell className="max-w-lg">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Create your personal account</h1>
      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        Use this if you&apos;ve been invited to an existing ProjexCloud workspace.
        If you want to start a new workspace for your company,{' '}
        <Link href="/signup" className="text-primary underline"><strong>sign up here</strong></Link> instead.
      </p>
      <RegisterForm onSuccess={(userId, email) => setWelcome({ userId, email })} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already signed up? <Link href="/login" className="text-primary hover:underline">Sign in</Link>.
      </p>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        By creating an account you agree to our <Link href="/terms" className="underline">Terms</Link>{' '}
        and <Link href="/privacy" className="underline">Privacy Policy</Link>.
      </p>
    </AuthShell>
  );
}
