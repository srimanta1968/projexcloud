import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CurrentUserBadge } from '@projexlight/design-system';
import '@projexlight/design-system/styles.css';

export const metadata: Metadata = {
  title: 'Tenant Admin',
  description: 'Tenant operator console — billing, members, webhooks, approvals.',
};

// Render every page per-request so server components read the live container
// env (e.g. TENANT_ADMIN_TENANT_ID) and current gateway data instead of a
// build-time static snapshot. This is an operator console over live data, so
// static optimization is never wanted here.
export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/billing', label: 'Billing' },
  { href: '/members', label: 'Members' },
  { href: '/api-keys', label: 'API keys' },
  { href: '/webhooks', label: 'Webhooks' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/consent', label: 'Consent' },
  { href: '/ai/mcp-servers', label: 'AI' },
  { href: '/ai/providers', label: 'AI Providers' },
  { href: '/byok', label: 'BYOK' },
  { href: '/help', label: 'Help' },
];

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-foreground px-5 py-3 text-background">
          <Link href="/" className="font-bold">Tenant Admin</Link>
          <span className="opacity-60">Tenant operator console</span>
          <nav className="ml-auto flex flex-wrap gap-4 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-background/90 hover:text-background">
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
