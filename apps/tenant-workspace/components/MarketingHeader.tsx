import Link from 'next/link';

/**
 * Shared top nav for public marketing routes (/, /features, /pricing, /security,
 * /terms, /privacy, /dpa). Authenticated routes (/dashboard, /admin/*, /build)
 * keep their own minimal headers via the dashboard layout.
 */
const NAV: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 32px', borderBottom: '1px solid #d7dce4', background: '#fff',
  fontFamily: 'system-ui, sans-serif',
};

const LINK: React.CSSProperties = {
  color: '#1b2a44', textDecoration: 'none', fontSize: 14, fontWeight: 500,
};

const CTA: React.CSSProperties = {
  background: '#0b1220', color: '#fff', padding: '8px 16px',
  borderRadius: 6, textDecoration: 'none', fontSize: 14, fontWeight: 600,
};

const CTA_SECONDARY: React.CSSProperties = {
  color: '#0b1220', padding: '8px 14px', textDecoration: 'none',
  fontSize: 14, fontWeight: 500,
};

export function MarketingHeader(): JSX.Element {
  return (
    <header style={NAV}>
      <Link href="/" style={{ ...LINK, fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>
        ProjexCloud
      </Link>

      <nav style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
        <Link href="/features" style={LINK}>Features</Link>
        <Link href="/pricing"  style={LINK}>Pricing</Link>
        <Link href="/security" style={LINK}>Security</Link>
        <a href="/docs/user/tenant-getting-started.html" style={LINK}>Docs</a>
      </nav>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Link href="/login"  style={CTA_SECONDARY}>Sign in</Link>
        <Link href="/signup" style={CTA}>Start free trial</Link>
      </div>
    </header>
  );
}
