'use client';

import Link from 'next/link';
import { useState } from 'react';
import SignupForm from '../../components/SignupForm';
import { AuthShell } from '../../components/AuthShell';
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
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Welcome to {welcome.display_name}.</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          Your trial workspace is live. You&apos;re signed in as <strong>{welcome.email}</strong>{' '}
          and have been added as its admin.
        </p>
        <div className="my-5 rounded-lg border bg-muted p-4 text-sm">
          <div><strong>Tenant ID:</strong> <code>{welcome.tenant_id}</code></div>
          <div><strong>App ID:</strong> <code>{welcome.app_id}</code></div>
          <div><strong>Org ID:</strong> <code>{welcome.org_id}</code></div>
          <div><strong>Region:</strong> {welcome.region}</div>
        </div>
        <h2 className="mt-7 text-lg font-semibold">Next steps</h2>
        <ol className="list-decimal space-y-1 pl-6 text-sm leading-relaxed">
          <li>Open the <a href="http://localhost:3200" target="_blank" rel="noreferrer" className="text-primary underline">Tenant Admin console</a> to invite teammates, add webhooks, and connect Slack / Salesforce / M365.</li>
          <li>Bookmark <a href="http://localhost:3200/billing" target="_blank" rel="noreferrer" className="text-primary underline">Billing</a> — check it weekly during your trial.</li>
          <li>Read the <a href="/docs/user/tenant-getting-started.html" target="_blank" rel="noreferrer" className="text-primary underline">Getting Started guide</a> — a 15-minute walkthrough of the trial.</li>
        </ol>
        <p className="mt-7 text-xs text-muted-foreground">
          Your token is stored locally; you&apos;ll stay signed in across reloads. If you sign out,
          come back to <Link href="/login" className="text-primary underline">/login</Link>.
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
