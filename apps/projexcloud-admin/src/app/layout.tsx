import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CurrentUserBadge } from '@projexlight/design-system';
import '@projexlight/design-system/styles.css';

export const metadata: Metadata = {
  title: 'ProjexCloud Admin',
  description: 'Platform operator console — tenants, pools, catalogs, gates.',
};

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/tenants', label: 'Tenants' },
  { href: '/pools', label: 'Pools' },
  { href: '/pricing-catalogs', label: 'Pricing' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/webhooks', label: 'Webhooks' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/audit', label: 'Audit' },
  { href: '/sovereign-regions', label: 'Sovereign' },
  { href: '/onprem-installs', label: 'On-Prem' },
  { href: '/active-active', label: 'Active-Active' },
  { href: '/config', label: 'Configuration' },
  { href: '/security/ops-tokens', label: 'Ops Tokens' },
  { href: '/notifications', label: 'Email' },
  { href: '/help', label: 'Help' },
];

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-primary px-5 py-3 text-primary-foreground">
          <Link href="/" className="font-bold">ProjexCloud Admin</Link>
          <span className="opacity-60">Platform operator console</span>
          <nav className="ml-auto flex flex-wrap gap-3.5 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-primary-foreground/90 hover:text-primary-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
          <CurrentUserBadge className="ml-4" loginPath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/login`} />
        </header>
        <main className="p-6">
          <Link href="/" className="text-[13px] text-muted-foreground hover:text-foreground">← Console home</Link>
          <div className="mt-3">{children}</div>
        </main>
      </body>
    </html>
  );
}
