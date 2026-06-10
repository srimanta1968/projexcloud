import Link from 'next/link';
import { PageHeader } from '@projexlight/design-system';

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
];

export default function HomePage(): JSX.Element {
  return (
    <div>
      <PageHeader
        title="Tenant Console"
        description="Self-service surfaces for tenant admins. All actions audit-trail back through the platform's hash-chained ledger."
      />
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
