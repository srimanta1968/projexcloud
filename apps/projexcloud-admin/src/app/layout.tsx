import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'ProjexCloud Admin',
  description: 'Platform operator console — tenants, pools, catalogs, gates.',
};

const LINK: React.CSSProperties = { color: '#e9eef7', textDecoration: 'none' };

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header style={{ background: '#0b1220', color: '#e9eef7', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <a href="/" style={{ ...LINK, fontWeight: 700 }}>ProjexCloud Admin</a>
          <span style={{ opacity: 0.6 }}>Platform operator console</span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: 14, flexWrap: 'wrap' }}>
            <a href="/" style={LINK}>Home</a>
            <a href="/tenants" style={LINK}>Tenants</a>
            <a href="/pools" style={LINK}>Pools</a>
            <a href="/pricing-catalogs" style={LINK}>Pricing</a>
            <a href="/invoices" style={LINK}>Invoices</a>
            <a href="/webhooks" style={LINK}>Webhooks</a>
            <a href="/approvals" style={LINK}>Approvals</a>
            <a href="/audit" style={LINK}>Audit</a>
            <a href="/sovereign-regions" style={LINK}>Sovereign</a>
            <a href="/onprem-installs" style={LINK}>On-Prem</a>
            <a href="/active-active" style={LINK}>Active-Active</a>
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
