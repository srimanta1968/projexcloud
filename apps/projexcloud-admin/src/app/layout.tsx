import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'ProjexCloud Admin',
  description: 'Platform operator console — tenants, pools, catalogs, gates.',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <header style={{ background: '#0b1220', color: '#e9eef7', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 24 }}>
          <strong>ProjexCloud Admin</strong>
          <span style={{ opacity: 0.6 }}>Platform operator console</span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontSize: 14 }}>
            <a href="/tenants" style={{ color: '#e9eef7', textDecoration: 'none' }}>Tenants</a>
            <a href="/pricing-catalogs" style={{ color: '#e9eef7', textDecoration: 'none' }}>Pricing</a>
            <a href="/sovereign-regions" style={{ color: '#e9eef7', textDecoration: 'none' }}>Sovereign</a>
            <a href="/onprem-installs" style={{ color: '#e9eef7', textDecoration: 'none' }}>On-Prem</a>
            <a href="/active-active" style={{ color: '#e9eef7', textDecoration: 'none' }}>Active-Active</a>
          </nav>
        </header>
        <main style={{ padding: 24 }}>{children}</main>
      </body>
    </html>
  );
}
