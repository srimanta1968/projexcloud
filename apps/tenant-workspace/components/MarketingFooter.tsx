import Link from 'next/link';

const COL_TITLE = 'mb-3 text-xs font-semibold uppercase tracking-wide text-foreground';
const COL_LINK = 'mb-2 block text-sm text-muted-foreground hover:text-foreground';

export function MarketingFooter(): JSX.Element {
  // Static docs are served under the portal basePath (/workspace in prod); raw
  // <a> links to them must include it or they 404 through the gateway.
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return (
    <footer className="mt-20 border-t bg-muted">
      <div className="mx-auto grid max-w-6xl grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-8 px-8 pb-8 pt-12">
        <div>
          <div className={COL_TITLE}>Product</div>
          <Link href="/features" className={COL_LINK}>Features</Link>
          <Link href="/pricing" className={COL_LINK}>Pricing</Link>
          <Link href="/security" className={COL_LINK}>Security</Link>
          <Link href="/build" className={COL_LINK}>AI Build</Link>
        </div>
        <div>
          <div className={COL_TITLE}>For Developers</div>
          <a href={`${base}/docs/hub/index.html`} className={COL_LINK}>Developer Hub</a>
          <a href={`${base}/docs/user/tenant-getting-started.html`} className={COL_LINK}>Getting started</a>
          <a href={`${base}/docs/user/tenant-admin-guide.html`} className={COL_LINK}>Tenant admin guide</a>
          <a href={`${base}/docs/api/index.html`} className={COL_LINK}>API reference</a>
          <a href={`${base}/docs/api/test-plan.html`} className={COL_LINK}>API test plan</a>
        </div>
        <div>
          <div className={COL_TITLE}>Company</div>
          <a href="mailto:sales@projexcloud.com" className={COL_LINK}>Talk to sales</a>
          <a href="mailto:support@projexcloud.com" className={COL_LINK}>Support</a>
        </div>
        <div>
          <div className={COL_TITLE}>Legal</div>
          <Link href="/terms" className={COL_LINK}>Terms of Service</Link>
          <Link href="/privacy" className={COL_LINK}>Privacy Policy</Link>
          <Link href="/dpa" className={COL_LINK}>Data Processing Agreement</Link>
        </div>
      </div>
      <div className="mx-auto flex max-w-6xl items-center justify-between border-t px-8 pb-8 pt-4 text-xs text-muted-foreground">
        <span>© {new Date().getFullYear()} ProjexCloud Inc.</span>
        <span>Multi-tenant SaaS platform · Identity · Billing · Audit · AI</span>
      </div>
    </footer>
  );
}
