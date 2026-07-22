'use client';

import Link from 'next/link';
import { useState } from 'react';
import SignupForm from '../../components/SignupForm';
import { AuthShell } from '../../components/AuthShell';
import { TENANT_URL, TENANT_BILLING_URL } from '../../lib/portalLinks';
import type { SignupTenantResponse } from '../../services/authApi';

/**
 * /signup — self-serve onboarding. Creates person + org + default app + trial
 * tenant + admin membership in one round-trip, then shows a welcome screen
 * with the new tenant's IDs and next-step links.
 */
export default function SignupPage(): JSX.Element {
  const [welcome, setWelcome] = useState<SignupTenantResponse | null>(null);

  if (welcome) {
    return (
      <AuthShell className="max-w-2xl">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Check your email to finish</h1>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          Your trial workspace <strong>{welcome.display_name}</strong> is created — but first,
          verify your email. We sent a link to <strong className="text-foreground">{welcome.email}</strong>.
          Click it to activate your account, then sign in.
        </p>
        <div className="my-5 rounded-lg border bg-muted p-4 text-sm">
          <div><strong>Tenant ID:</strong> <code>{welcome.tenant_id}</code></div>
          <div><strong>Region:</strong> {welcome.region}</div>
        </div>
        <h2 className="mt-6 text-lg font-semibold">Once verified</h2>
        <ol className="list-decimal space-y-1 pl-6 text-sm leading-relaxed">
          <li><Link href="/login" className="text-primary underline">Sign in</Link> to your new workspace.</li>
          <li>Open the <a href={TENANT_URL} target="_blank" rel="noreferrer" className="text-primary underline">Tenant Admin console</a> to invite teammates and connect Slack / Salesforce / M365.</li>
          <li>Read the <a href="/docs/user/tenant-getting-started.html" target="_blank" rel="noreferrer" className="text-primary underline">Getting Started guide</a>.</li>
        </ol>
        <p className="mt-7 text-xs text-muted-foreground">
          The verification link expires in 24 hours. Don&apos;t see it? Check your spam folder.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell className="max-w-lg">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Create your workspace</h1>
      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        Free 14-day trial. No credit card. You&apos;ll be the admin of a brand-new
        ProjexCloud workspace scoped to your company.
      </p>
      <SignupForm onSuccess={setWelcome} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already invited to an existing workspace?{' '}
        <Link href="/register" className="text-primary hover:underline">Create a personal account</Link> instead.
      </p>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        By signing up you agree to our <Link href="/terms" className="underline">Terms</Link>{' '}
        and <Link href="/privacy" className="underline">Privacy Policy</Link>.
      </p>
    </AuthShell>
  );
}
