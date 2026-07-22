import Link from 'next/link';
import { Button } from '@projexlight/design-system';

/**
 * Shared top nav for public marketing routes (/, /features, /pricing, /security,
 * /terms, /privacy, /dpa). Authenticated routes (/dashboard, /admin/*, /build)
 * keep their own minimal headers via the dashboard layout.
 */
export function MarketingHeader(): JSX.Element {
  // Static docs live in public/ and are served UNDER the portal basePath
  // (/workspace in prod). Next.js only auto-prefixes <Link>, not raw <a>, so
  // links to these .html files must add the basePath themselves or they fall
  // through nginx to the gateway and 404.
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return (
    <header className="flex items-center justify-between border-b bg-background px-8 py-4">
      <Link href="/" className="text-lg font-bold tracking-tight text-foreground">
        ProjexCloud
      </Link>

      <nav className="flex items-center gap-7 text-sm font-medium text-foreground">
        <Link href="/features" className="hover:text-primary">Features</Link>
        <Link href="/pricing" className="hover:text-primary">Pricing</Link>
        <Link href="/security" className="hover:text-primary">Security</Link>
        <a href={`${base}/docs/hub/index.html`} className="hover:text-primary">Developer Hub</a>
        <a href={`${base}/docs/api/index.html`} className="hover:text-primary">API</a>
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
