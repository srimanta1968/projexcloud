import Link from 'next/link';
import { Button } from '@projexlight/design-system';

/**
 * Shared top nav for public marketing routes (/, /features, /pricing, /security,
 * /terms, /privacy, /dpa). Authenticated routes (/dashboard, /admin/*, /build)
 * keep their own minimal headers via the dashboard layout.
 */
export function MarketingHeader(): JSX.Element {
  return (
    <header className="flex items-center justify-between border-b bg-background px-8 py-4">
      <Link href="/" className="text-lg font-bold tracking-tight text-foreground">
        ProjexCloud
      </Link>

      <nav className="flex items-center gap-7 text-sm font-medium text-foreground">
        <Link href="/features" className="hover:text-primary">Features</Link>
        <Link href="/pricing" className="hover:text-primary">Pricing</Link>
        <Link href="/security" className="hover:text-primary">Security</Link>
        <a href="/docs/user/tenant-getting-started.html" className="hover:text-primary">Docs</a>
      </nav>

      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/signup">Start free trial</Link>
        </Button>
      </div>
    </header>
  );
}
