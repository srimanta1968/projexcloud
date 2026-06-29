import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CurrentUserBadge } from '@projexlight/design-system';
import '@projexlight/design-system/styles.css';

export const metadata: Metadata = {
  title: 'ProjexCloud',
  description: 'Ship multi-tenant SaaS in days — identity, billing, audit, AI, compliance pre-wired.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-5 py-3">
          <Link href="/" className="font-bold">ProjexCloud Workspace</Link>
          <CurrentUserBadge className="ml-auto" loginPath="/login" />
        </header>
        {children}
      </body>
    </html>
  );
}
