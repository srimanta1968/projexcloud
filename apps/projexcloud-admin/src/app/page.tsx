import Link from 'next/link';

const SECTIONS = [
  { href: '/tenants',      label: 'Tenants',        desc: 'Provision, suspend, offboard' },
  { href: '/pools',        label: 'Pools',          desc: 'Pool routing + status flips' },
  { href: '/pricing-catalogs', label: 'Pricing catalogs', desc: 'Catalog versioning + soft caps' },
  { href: '/invoices',     label: 'Invoices',       desc: 'Per-tenant invoice search' },
  { href: '/webhooks',     label: 'Webhooks',       desc: 'Tenant webhooks + DLQ replay' },
  { href: '/approvals',    label: 'Approvals',      desc: 'Routes + pending requests' },
  { href: '/audit',        label: 'Audit',          desc: 'Hash-chain trail browser' },
];

export default function HomePage(): JSX.Element {
  return (
    <div>
      <h1>Platform Console</h1>
      <p style={{ color: '#5a6573' }}>
        Operator surfaces for every ProjexCloud SDK. Each section talks to{' '}
        <code>{process.env.NEXT_PUBLIC_GATEWAY_URL}</code> with operator-scoped JWTs.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 24 }}>
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}
            style={{
              display: 'block',
              padding: 16,
              background: '#f3f5f8',
              borderRadius: 8,
              textDecoration: 'none',
              color: 'inherit',
              border: '1px solid #d7dce4',
            }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 13, color: '#5a6573' }}>{s.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
