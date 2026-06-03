'use client';

import Link from 'next/link';
import { useState } from 'react';
import SignupForm from '../../components/SignupForm';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';
import type { SignupTenantResponse } from '../../services/authApi';

/**
 * /signup — self-serve onboarding. Creates person + org + default app + trial
 * tenant + admin membership in one round-trip, then shows a welcome screen
 * with the new tenant's IDs and next-step links.
 */

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const SHELL: React.CSSProperties = { padding: '56px 32px', background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)' };
const FORM_CARD: React.CSSProperties = {
  maxWidth: 480, margin: '0 auto', background: '#fff', padding: '32px 36px',
  border: '1px solid #d7dce4', borderRadius: 12, boxShadow: '0 4px 16px rgba(11,18,32,0.04)',
};
const H1: React.CSSProperties = { fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 8px' };
const LEAD: React.CSSProperties = { color: '#5a6573', fontSize: 15, marginBottom: 24, lineHeight: 1.55 };
const FOOT: React.CSSProperties = { marginTop: 24, fontSize: 14, color: '#5a6573', textAlign: 'center' };

const SUCCESS_WRAP: React.CSSProperties = { maxWidth: 680, margin: '0 auto', background: '#fff', padding: '36px 40px', border: '1px solid #d7dce4', borderRadius: 12 };
const ID_BLOCK: React.CSSProperties = { background: '#f1f5fb', padding: 16, borderRadius: 8, margin: '20px 0', fontSize: 14, border: '1px solid #d3dbe8' };

export default function SignupPage(): JSX.Element {
  const [welcome, setWelcome] = useState<SignupTenantResponse | null>(null);

  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={SHELL}>
        {welcome ? (
          <div style={SUCCESS_WRAP}>
            <h1 style={H1}>Welcome to {welcome.display_name}.</h1>
            <p style={LEAD}>
              Your trial workspace is live. You&apos;re signed in as <strong>{welcome.email}</strong>{' '}
              and have been added as its admin.
            </p>
            <div style={ID_BLOCK}>
              <div><strong>Tenant ID:</strong> <code>{welcome.tenant_id}</code></div>
              <div><strong>App ID:</strong> <code>{welcome.app_id}</code></div>
              <div><strong>Org ID:</strong> <code>{welcome.org_id}</code></div>
              <div><strong>Region:</strong> {welcome.region}</div>
            </div>
            <h2 style={{ marginTop: 28, fontSize: 18 }}>Next steps</h2>
            <ol style={{ paddingLeft: 22, fontSize: 15, lineHeight: 1.7 }}>
              <li>Open the <a href="http://localhost:3200" target="_blank" rel="noreferrer">Tenant Admin console</a> to invite teammates, add webhooks, and connect Slack / Salesforce / M365.</li>
              <li>Bookmark <a href="http://localhost:3200/billing" target="_blank" rel="noreferrer">Billing</a> — check it weekly during your trial.</li>
              <li>Read the <a href="/docs/user/tenant-getting-started.html" target="_blank" rel="noreferrer">Getting Started guide</a> — a 15-minute walkthrough of the trial.</li>
            </ol>
            <p style={{ marginTop: 28, fontSize: 13, color: '#7a8597' }}>
              Your token is stored locally; you&apos;ll stay signed in across reloads. If you sign out,
              come back to <Link href="/login">/login</Link>.
            </p>
          </div>
        ) : (
          <div style={FORM_CARD}>
            <h1 style={H1}>Create your workspace</h1>
            <p style={LEAD}>
              Free 14-day trial. No credit card. You&apos;ll be the admin of a brand-new
              ProjexCloud workspace scoped to your company.
            </p>
            <SignupForm onSuccess={setWelcome} />
            <p style={FOOT}>
              Already invited to an existing workspace?{' '}
              <Link href="/register">Create a personal account</Link> instead.
            </p>
            <p style={{ ...FOOT, fontSize: 12, color: '#7a8597', marginTop: 12 }}>
              By signing up you agree to our <Link href="/terms">Terms</Link>{' '}
              and <Link href="/privacy">Privacy Policy</Link>.
            </p>
          </div>
        )}
      </section>

      <MarketingFooter />
    </div>
  );
}
