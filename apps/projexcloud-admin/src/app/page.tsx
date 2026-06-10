import Link from 'next/link';
import { PageHeader } from '@projexlight/design-system';

const SECTIONS = [
  { href: '/tenants', label: 'Tenants', desc: 'Provision, suspend, offboard' },
  { href: '/pools', label: 'Pools', desc: 'Pool routing + status flips' },
  { href: '/pricing-catalogs', label: 'Pricing catalogs', desc: 'Catalog versioning + soft caps' },
  { href: '/invoices', label: 'Invoices', desc: 'Per-tenant invoice search' },
  { href: '/webhooks', label: 'Webhooks', desc: 'Tenant webhooks + DLQ replay' },
  { href: '/approvals', label: 'Approvals', desc: 'Routes + pending requests' },
  { href: '/audit', label: 'Audit', desc: 'Hash-chain trail browser' },
  { href: '/sovereign-regions', label: 'Sovereign regions', desc: 'FedRAMP / IL5 / PIPL / EU sovereign' },
  { href: '/onprem-installs', label: 'On-Prem installs', desc: 'Air-gapped customers + bundle releases' },
  { href: '/active-active', label: 'Active-Active', desc: 'Tier-G+ profiles + chaos drills' },
];

export default function HomePage(): JSX.Element {
  return (
    <div>
      <PageHeader
        title="Platform Console"
        description={
          <>
            Operator surfaces for every ProjexCloud SDK. Each section talks to{' '}
            <code>{process.env.NEXT_PUBLIC_GATEWAY_URL}</code> with operator-scoped JWTs.
          </>
        }
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block rounded-lg border bg-muted p-4 transition-colors hover:bg-accent"
          >
            <div className="mb-1 font-semibold">{s.label}</div>
            <div className="text-[13px] text-muted-foreground">{s.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
