'use client';

import Link from 'next/link';
import { useState } from 'react';
import SignupForm from '../../components/SignupForm';
import type { SignupTenantResponse } from '../../services/authApi';

/**
 * /signup — self-serve onboarding. Creates a person + org + default app + trial
 * tenant + admin membership in one round-trip, then shows a welcome screen
 * with the new tenant's IDs and next-step links.
 */
export default function SignupPage(): JSX.Element {
  const [welcome, setWelcome] = useState<SignupTenantResponse | null>(null);

  if (welcome) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Welcome to {welcome.display_name}.</h1>
        <p style={{ color: '#5a6573' }}>
          Your trial workspace is live. You're signed in as <strong>{welcome.email}</strong> and
          have been added as its admin.
        </p>

        <div style={{ background: '#f3f5f8', padding: 16, borderRadius: 8, margin: '20px 0', fontSize: 14 }}>
          <div><strong>Tenant ID:</strong> <code>{welcome.tenant_id}</code></div>
          <div><strong>App ID:</strong> <code>{welcome.app_id}</code></div>
          <div><strong>Org ID:</strong> <code>{welcome.org_id}</code></div>
          <div><strong>Region:</strong> {welcome.region}</div>
        </div>

        <h2 style={{ marginTop: 32, fontSize: 18 }}>Next steps</h2>
        <ol>
          <li>
            Open the <a href="http://localhost:3200" target="_blank" rel="noreferrer">Tenant Admin console</a>{' '}
            to invite teammates, add webhooks, and connect Slack/Salesforce/M365.
          </li>
          <li>
            Bookmark <a href="http://localhost:3200/billing" target="_blank" rel="noreferrer">Billing</a> —
            check it weekly during your trial.
          </li>
          <li>
            Read the <a href="http://localhost:3200/help" target="_blank" rel="noreferrer">tenant admin guide</a> —
            covers Day-1 onboarding step by step.
          </li>
        </ol>

        <p style={{ marginTop: 32, fontSize: 13, color: '#7a8597' }}>
          Your token is stored locally; you'll stay signed in across reloads. If you sign out,
          come back to <Link href="/login">/login</Link>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Create your workspace</h1>
      <p style={{ color: '#5a6573' }}>
        Free trial. No credit card. You'll be the admin of a brand-new ProjexCloud workspace
        scoped to your company.
      </p>

      <SignupForm onSuccess={setWelcome} />

      <p style={{ marginTop: 24, fontSize: 14 }}>
        Already invited to an existing workspace?{' '}
        <Link href="/register">Create a personal account</Link> instead.
      </p>
    </main>
  );
}
