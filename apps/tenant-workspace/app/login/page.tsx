'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LoginForm from '../../components/LoginForm';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

/**
 * /login — returning-user sign-in. On success, lands on /dashboard which
 * reads the persisted JWT and renders the appropriate workspace shell.
 */

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const SHELL: React.CSSProperties = { padding: '56px 32px', background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)' };
const FORM_CARD: React.CSSProperties = {
  maxWidth: 440, margin: '0 auto', background: '#fff', padding: '32px 36px',
  border: '1px solid #d7dce4', borderRadius: 12, boxShadow: '0 4px 16px rgba(11,18,32,0.04)',
};
const H1: React.CSSProperties = { fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 8px' };
const LEAD: React.CSSProperties = { color: '#5a6573', fontSize: 15, marginBottom: 24, lineHeight: 1.55 };

export default function LoginPage(): JSX.Element {
  const router = useRouter();

  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={SHELL}>
        <div style={FORM_CARD}>
          <h1 style={H1}>Sign in</h1>
          <p style={LEAD}>
            Welcome back. Sign in with the email and password you used at signup.
          </p>

          <LoginForm onSuccess={() => router.push('/dashboard')} />

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, fontSize: 14 }}>
            <Link href="/signup">Create a workspace</Link>
            <Link href="/register">I was invited</Link>
          </div>

          <p style={{ marginTop: 28, fontSize: 12, color: '#7a8597', textAlign: 'center' }}>
            Tenant admins manage their workspace at{' '}
            <a href="http://localhost:3200">localhost:3200</a>. Platform staff run at{' '}
            <a href="http://localhost:3100">localhost:3100</a>.
          </p>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
