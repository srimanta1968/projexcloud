'use client';

import Link from 'next/link';
import { useState } from 'react';
import RegisterForm from '../../components/RegisterForm';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

/**
 * /register — personal account only (no tenant created). Used by people who
 * were invited to an existing tenant. New customers should use /signup
 * (which creates a person + org + tenant in one flow).
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

const SUCCESS_WRAP: React.CSSProperties = { maxWidth: 540, margin: '0 auto', background: '#fff', padding: '36px 40px', border: '1px solid #d7dce4', borderRadius: 12 };

export default function RegisterPage(): JSX.Element {
  const [welcome, setWelcome] = useState<{ userId: string; email: string } | null>(null);

  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={SHELL}>
        {welcome ? (
          <div style={SUCCESS_WRAP}>
            <h1 style={H1}>Welcome, {welcome.email}</h1>
            <p style={LEAD}>
              Your user ID is <code style={{ background: '#f1f5fb', padding: '2px 6px', borderRadius: 4 }}>{welcome.userId}</code>.
            </p>
            <p style={{ color: '#5a6573', fontSize: 15, lineHeight: 1.6 }}>
              Your personal account is created but you&apos;re not attached to any workspace yet.
              Ask your workspace admin to invite this email, or{' '}
              <Link href="/signup">create your own workspace</Link>.
            </p>
            <p style={{ marginTop: 24, fontSize: 13, color: '#7a8597' }}>
              Already signed in? <Link href="/dashboard">Go to your workspace dashboard</Link>.
            </p>
          </div>
        ) : (
          <div style={FORM_CARD}>
            <h1 style={H1}>Create your personal account</h1>
            <p style={LEAD}>
              Use this if you&apos;ve been invited to an existing ProjexCloud workspace.
              If you want to start a new workspace for your company,{' '}
              <Link href="/signup"><strong>sign up here</strong></Link> instead.
            </p>
            <RegisterForm onSuccess={(userId, email) => setWelcome({ userId, email })} />
            <p style={FOOT}>
              Already signed up? <Link href="/login">Sign in</Link>.
            </p>
            <p style={{ ...FOOT, fontSize: 12, color: '#7a8597', marginTop: 12 }}>
              By creating an account you agree to our <Link href="/terms">Terms</Link>{' '}
              and <Link href="/privacy">Privacy Policy</Link>.
            </p>
          </div>
        )}
      </section>

      <MarketingFooter />
    </div>
  );
}
