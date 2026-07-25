import Link from 'next/link';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@projexlight/design-system/auth';
import { PageHeader, SetupChecklist } from '@projexlight/design-system';
import type { SetupStep } from '@projexlight/design-system';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  { href: '/billing', label: 'Billing', desc: 'Invoices, showback, live meter' },
  { href: '/members', label: 'Members', desc: 'Personas, roles, BUs' },
  { href: '/api-keys', label: 'API keys', desc: 'Issue, rotate, revoke' },
  { href: '/webhooks', label: 'Webhooks', desc: 'Endpoints + DLQ replay' },
  { href: '/approvals', label: 'Approvals', desc: 'Routes + my pending decisions' },
  { href: '/connectors', label: 'Connectors', desc: 'Slack, Salesforce, M365, others' },
  { href: '/consent', label: 'Consent', desc: 'Receipts + purposes' },
  { href: '/ai/mcp-servers', label: 'AI / MCP', desc: 'Registered MCP servers + tool inventory' },
  { href: '/byok', label: 'BYOK', desc: 'Bring your own KMS key (CMK binding)' },
  {
    href: '/config',
    label: 'Settings & Integrations',
    desc: 'AWS/S3, payment, email, search for your tenant',
  },
];

/** The tenant-scope config keys the onboarding checklist tracks. */
const SETUP_KEYS: { key: string; label: string; description: string }[] = [
  { key: 'aws.s3', label: 'AWS / S3 storage', description: 'Store your app files in your own bucket.' },
  { key: 'payment.provider', label: 'Payment collection', description: 'Collect payments from your customers.' },
  {
    key: 'notification.email.credential',
    label: 'Email provider',
    description: 'Send email from your own provider.',
  },
  { key: 'search.provider', label: 'Search backend', description: 'Point your app at your search endpoint.' },
];

/** Set of tenant-scope config keys that already have an active row. Fail-soft. */
async function fetchConfiguredKeys(): Promise<Set<string>> {
  try {
    const jwt = cookies().get(SESSION_COOKIE)?.value ?? '';
    const res = await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/config?scope=tenant`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return new Set();
    const rows: { key: string }[] = (await res.json()).data ?? [];
    return new Set(rows.map((r) => r.key));
  } catch {
    return new Set();
  }
}

export default async function HomePage(): Promise<JSX.Element> {
  const configured = await fetchConfiguredKeys();
  const steps: SetupStep[] = SETUP_KEYS.map((s) => ({
    label: s.label,
    description: s.description,
    done: configured.has(s.key),
    href: '/config',
  }));

  return (
    <div>
      <PageHeader
        title="Tenant Console"
        description="Self-service surfaces for tenant admins. All actions audit-trail back through the platform's hash-chained ledger."
      />
      <div className="mb-5 max-w-3xl">
        <SetupChecklist
          title="Tenant setup"
          subtitle="Connect your providers so your apps can send email, take payments and store files."
          steps={steps}
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
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
