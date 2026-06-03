import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Tenant Admin',
  description: 'Tenant operator console — billing, members, webhooks, approvals.',
};

const LINK: React.CSSProperties = { color: '#f0f3f9', textDecoration: 'none' };

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header style={{ background: '#1b2a44', color: '#f0f3f9', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 24 }}>
          <a href="/" style={{ ...LINK, fontWeight: 700 }}>Tenant Admin</a>
          <span style={{ opacity: 0.6 }}>Tenant operator console</span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontSize: 14 }}>
            <a href="/" style={LINK}>Home</a>
            <a href="/billing" style={LINK}>Billing</a>
            <a href="/members" style={LINK}>Members</a>
            <a href="/api-keys" style={LINK}>API keys</a>
            <a href="/webhooks" style={LINK}>Webhooks</a>
            <a href="/approvals" style={LINK}>Approvals</a>
            <a href="/connectors" style={LINK}>Connectors</a>
            <a href="/consent" style={LINK}>Consent</a>
            <a href="/ai/mcp-servers" style={LINK}>AI</a>
            <a href="/ai/providers" style={LINK}>AI Providers</a>
            <a href="/byok" style={LINK}>BYOK</a>
            <a href="/help" style={LINK}>Help</a>
          </nav>
        </header>
        <main style={{ padding: 24 }}>
          <a href="/" style={{ fontSize: 13, color: '#5a6573', textDecoration: 'none' }}>← Console home</a>
          <div style={{ marginTop: 12 }}>{children}</div>
        </main>
      </body>
    </html>
  );
}
