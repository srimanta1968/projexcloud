import Link from 'next/link';

const SECTIONS = [
  { href: '/billing',          label: 'Billing',     desc: 'Invoices, showback, live meter' },
  { href: '/members',          label: 'Members',     desc: 'Personas, roles, BUs' },
  { href: '/api-keys',         label: 'API keys',    desc: 'Issue, rotate, revoke' },
  { href: '/webhooks',         label: 'Webhooks',    desc: 'Endpoints + DLQ replay' },
  { href: '/approvals',        label: 'Approvals',   desc: 'Routes + my pending decisions' },
  { href: '/connectors',       label: 'Connectors',  desc: 'Slack, Salesforce, M365, others' },
  { href: '/consent',          label: 'Consent',     desc: 'Receipts + purposes' },
  { href: '/ai/mcp-servers',   label: 'AI / MCP',    desc: 'Registered MCP servers + tool inventory' },
  { href: '/byok',             label: 'BYOK',        desc: 'Bring your own KMS key (CMK binding)' },
];

export default function HomePage(): JSX.Element {
  return (
    <div>
      <h1>Tenant Console</h1>
      <p style={{ color: '#5a6573' }}>
        Self-service surfaces for tenant admins. All actions audit-trail back through the
        platform's hash-chained ledger.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 24 }}>
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}
            style={{
              display: 'block',
              padding: 16,
              background: '#f1f5fb',
              borderRadius: 8,
              textDecoration: 'none',
              color: 'inherit',
              border: '1px solid #d3dbe8',
            }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: '#5a6573' }}>{s.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
