import Link from 'next/link';
import { PageHeader, SetupChecklist, type SetupStep } from '@projexlight/design-system';
import { fetchPlatformConfig, PLATFORM_SETUP_KEYS } from './config/platformConfig';

const SECTIONS = [
  { href: '/config', label: 'Configuration', desc: 'Platform-scope config plane (LLM, payment, email, S3, search)' },
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

export default async function HomePage(): Promise<JSX.Element> {
  // Fail-soft: fetchPlatformConfig already swallows errors and returns [], so an
  // unreachable gateway renders the checklist with every step not-done.
  const rows = await fetchPlatformConfig();
  const configured = new Set(rows.map((r) => r.key));
  const steps: SetupStep[] = PLATFORM_SETUP_KEYS.map((s) => {
    const done = configured.has(s.key);
    return {
      label: s.label,
      description: s.description,
      done,
      ...(done ? {} : { href: '/config', cta: 'Set up →' }),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform Console"
        description={
          <>
            Operator surfaces for every ProjexCloud SDK. Each section talks to{' '}
            <code>{process.env.NEXT_PUBLIC_GATEWAY_URL}</code> with operator-scoped JWTs.
          </>
        }
      />
      <SetupChecklist
        title="Platform setup"
        subtitle="Configure the defaults every tenant inherits."
        steps={steps}
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
