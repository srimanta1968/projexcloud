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
        <header style={{ background: '#0b1220', color: '#e9eef7', padding: '12px 20px' }}>
          <strong>ProjexCloud Admin</strong>
          <span style={{ marginLeft: 12, opacity: 0.6 }}>Platform operator console</span>
        </header>
        <main style={{ padding: 24 }}>{children}</main>
      </body>
    </html>
  );
}
