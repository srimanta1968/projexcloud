import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from './AppHeader';
import '@projexlight/design-system/styles.css';

export const metadata: Metadata = {
  title: 'ProjexCloud',
  description: 'Ship multi-tenant SaaS in days — identity, billing, audit, AI, compliance pre-wired.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppHeader />
        {children}
      </body>
    </html>
  );
}
