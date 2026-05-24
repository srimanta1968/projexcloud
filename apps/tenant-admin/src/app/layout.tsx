import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Tenant Admin',
  description: 'Tenant operator console — billing, members, webhooks, approvals.',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header style={{ background: '#1b2a44', color: '#f0f3f9', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 24 }}>
          <strong>Tenant Admin</strong>
          <span style={{ opacity: 0.6 }}>Tenant operator console</span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontSize: 14 }}>
            <a href="/billing" style={{ color: '#f0f3f9', textDecoration: 'none' }}>Billing</a>
            <a href="/ai" style={{ color: '#f0f3f9', textDecoration: 'none' }}>AI</a>
            <a href="/byok" style={{ color: '#f0f3f9', textDecoration: 'none' }}>BYOK</a>
          </nav>
        </header>
        <main style={{ padding: 24 }}>{children}</main>
      </body>
    </html>
  );
}
