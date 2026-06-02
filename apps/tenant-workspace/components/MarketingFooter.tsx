import Link from 'next/link';

const FOOTER: React.CSSProperties = {
  marginTop: 80,
  borderTop: '1px solid #d7dce4',
  background: '#f8fafd',
  fontFamily: 'system-ui, sans-serif',
};

const GRID: React.CSSProperties = {
  maxWidth: 1100, margin: '0 auto', padding: '48px 32px 32px',
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 32,
};

const COL_TITLE: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, color: '#1b2a44', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
};

const COL_LINK: React.CSSProperties = {
  display: 'block', color: '#5a6573', textDecoration: 'none', fontSize: 14, marginBottom: 8,
};

const BAR: React.CSSProperties = {
  maxWidth: 1100, margin: '0 auto', padding: '16px 32px 32px',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 13, color: '#7a8597', borderTop: '1px solid #e3e8f0',
};

export function MarketingFooter(): JSX.Element {
  return (
    <footer style={FOOTER}>
      <div style={GRID}>
        <div>
          <div style={COL_TITLE}>Product</div>
          <Link href="/features" style={COL_LINK}>Features</Link>
          <Link href="/pricing"  style={COL_LINK}>Pricing</Link>
          <Link href="/security" style={COL_LINK}>Security</Link>
          <Link href="/build"    style={COL_LINK}>AI Build</Link>
        </div>
        <div>
          <div style={COL_TITLE}>For Developers</div>
          <a href="/docs/user/tenant-getting-started.html" style={COL_LINK}>Getting started</a>
          <a href="/docs/user/tenant-admin-guide.html"     style={COL_LINK}>Tenant admin guide</a>
          <a href="/docs/v3.1/Architecture-v3.1.html"      style={COL_LINK}>Architecture</a>
        </div>
        <div>
          <div style={COL_TITLE}>Company</div>
          <a href="mailto:sales@projexcloud.com" style={COL_LINK}>Talk to sales</a>
          <a href="mailto:support@projexcloud.com" style={COL_LINK}>Support</a>
        </div>
        <div>
          <div style={COL_TITLE}>Legal</div>
          <Link href="/terms"   style={COL_LINK}>Terms of Service</Link>
          <Link href="/privacy" style={COL_LINK}>Privacy Policy</Link>
          <Link href="/dpa"     style={COL_LINK}>Data Processing Agreement</Link>
        </div>
      </div>
      <div style={BAR}>
        <span>© {new Date().getFullYear()} ProjexCloud Inc.</span>
        <span>Multi-tenant SaaS platform · Identity · Billing · Audit · AI</span>
      </div>
    </footer>
  );
}
