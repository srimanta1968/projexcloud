import Link from 'next/link';
import { Badge, Button } from '@projexlight/design-system';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

interface Feature {
  tag: string;
  title: string;
  body: string;
  bullets: string[];
  badge?: string;
}

const FEATURES: Feature[] = [
  {
    tag: 'Identity',
    title: 'Six-layer identity stack',
    body: 'Every JWT carries six scopes: Master Person, App Identity, Tenant Membership, Persona, Encounter, Relationship. The platform filters every read and write through those scopes — there is no path to another tenant\'s data, even by accident.',
    bullets: [
      'Self-serve signup mints all six layers in one round trip.',
      'Social IdP (Google, Microsoft, Apple), SAML SP, SCIM 2.0 user provisioning.',
      'MFA challenge + step-up auth, impersonation grants with approval flow + audit.',
      'OIDC discovery + JWKS endpoints out of the box.',
    ],
  },
  {
    tag: 'Encryption',
    title: 'Customer-managed keys (BYOK / CMEK)',
    body: 'Tenants on the Pro and Enterprise tiers bind their own AWS KMS, GCP KMS, or HSM (PKCS#11) key to wrap the platform\'s Tenant Key envelope. Revoke the grant on your KMS and this tenant\'s data becomes undecryptable platform-wide within 30 seconds. The kill-switch your auditors keep asking about.',
    bullets: [
      'Four-tier vault hierarchy: Platform KEK → Tenant KEK → DEK → Per-resource keys.',
      'SIEM forwarding hooks so all key-usage events stream to the customer\'s SOC.',
      'Cryptographic shredding for right-to-be-forgotten and time-bound retention.',
      'Tenant-level rotation with a 10-minute grace window so config swaps don\'t outage.',
    ],
  },
  {
    tag: 'AI Gateway',
    title: 'Governed multi-provider AI',
    body: 'One endpoint, four providers (OpenAI, Anthropic, Bedrock, Gemini). Every call goes through PII redaction, per-tenant routing rules, soft-cap and hard-cap budgets, and a Langfuse trace. Bringing your own AI provider keys is the next step.',
    bullets: [
      'Streaming + non-streaming completions, model allowlists, cost passthrough + margin.',
      'Per-tenant route rules: send PHI prompts to a HIPAA-covered model, everything else to Frontier.',
      'Circuit breakers per provider so a Bedrock incident doesn\'t cascade.',
      'BYOK for AI provider keys: rolling out Q3 2026; tenants on their own key pay only the governance SKU.',
    ],
    badge: 'BYOK Q3 2026',
  },
  {
    tag: 'Audit',
    title: 'Append-only audit chain',
    body: 'Every admin-side action — member added, key revoked, policy changed, AI completion run — appends to a per-tenant SHA-256-chained ledger. Verify the chain on demand. Export to PDF or JSON. Survives a courtroom.',
    bullets: [
      'Three retention classes: transient (7d), operational (90d), regulated (7y).',
      'Independent per-tenant chain heads so a chain break is locally contained.',
      'Cross-system trace IDs link audit rows to Langfuse, OpenTelemetry, and provider invoices.',
      'Background verifier scheduler scans chains on a configurable cadence; alarms on break.',
    ],
  },
  {
    tag: 'Vertical Packs',
    title: 'Composed verticals, not raw SDKs',
    body: 'Healthcare, FinServ, RevOps, Field-service, Public Sector. Each pack composes pre-tested SDKs with compliance attestations and a working starter app. Pick a pack at signup or via /build; the platform pre-installs the right module_subscriptions, seeds demo data, and routes new tenants to the right pool family.',
    bullets: [
      'Healthcare: sdk-evidence + sdk-consent + sdk-data-rights + hdk-camera, HIPAA + 21 CFR Part 11 mapped.',
      'FinServ: sdk-audit + sdk-approval + sdk-policy + sdk-sovereign, SOX + PCI-DSS mapped.',
      'RevOps: sdk-crm + sdk-engagement + sdk-lead-scoring + sdk-campaign + connector-salesforce.',
      'Field-service: sdk-dispatch + sdk-assignment + sdk-storm + hdk-map + hdk-camera.',
      'Public Sector: sdk-sovereign + sdk-onprem + sdk-data-rights, FedRAMP-Moderate / StateRAMP mapped.',
    ],
  },
  {
    tag: 'AI Build',
    title: 'From prompt to running app',
    body: 'At /build inside the tenant workspace, describe the application in plain English. The cloud agent matches your prompt to a vertical blueprint, asks two or three clarifying questions, scaffolds the app inside an isolated sandbox in your tenant pool, runs migrations, seeds demo data, and hands you a working URL.',
    bullets: [
      'Powered by sdk-agent-runtime + sdk-ai-gateway, scoped to the blueprint catalog.',
      'Local CLI alternative (projex init / install / deploy) drops .claude/mcp.json or cursor.mcp.json so any AI coding tool gets full SDK discovery via MCP.',
      'Every scaffold writes to your audit ledger so platform staff can\'t silently change your app.',
    ],
  },
  {
    tag: 'Deployment',
    title: 'Single-region to sovereign',
    body: 'Starter and Pro run on shared multi-region infrastructure. Enterprise opens active-active across regions, sovereign region pinning (EU, UK, FedRAMP, StateRAMP, IL5, PIPL), and air-gapped on-prem bundles for the deployments that legally cannot use shared cloud.',
    bullets: [
      'Pool-based horizontal scaling — no sharding, no manual capacity planning.',
      'Active-active multi-region with chaos drills as a first-class operation.',
      'Sovereign regions with attestation issuance and leak-alert audit events.',
      'On-prem bundles with rollback support and local-LLM provider resolver.',
    ],
  },
];

export default function FeaturesPage(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />

      <section className="bg-gradient-to-b from-background to-muted px-8 pb-8 pt-[72px] text-center">
        <h1 className="mx-auto mb-3 max-w-2xl text-4xl font-bold tracking-tight">Features</h1>
        <p className="mx-auto max-w-xl text-lg leading-relaxed text-muted-foreground">
          Everything you need to ship multi-tenant SaaS without rebuilding the
          plumbing every quarter. Pick what you use; the rest is opt-in.
        </p>
      </section>

      {FEATURES.map((f) => (
        <section key={f.tag} className="border-t px-8 py-14">
          <div className="mx-auto grid max-w-4xl gap-x-6 gap-y-4 md:grid-cols-[180px_1fr]">
            <div className="text-xs font-semibold uppercase tracking-wider text-brand">{f.tag}</div>
            <div>
              <h2 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
                {f.title}
                {f.badge && <Badge variant="warning">{f.badge}</Badge>}
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed">{f.body}</p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                {f.bullets.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          </div>
        </section>
      ))}

      <section className="bg-muted px-8 py-16 text-center">
        <h2 className="mb-3 text-2xl font-bold tracking-tight">Ready to try it?</h2>
        <p className="mx-auto mb-2 max-w-xl text-base text-muted-foreground">
          14-day free trial, no credit card. See <Link href="/pricing" className="text-primary underline">pricing</Link>{' '}
          or read <a href="/docs/user/tenant-getting-started.html" className="text-primary underline">getting started</a>.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild><Link href="/signup">Start free trial</Link></Button>
          <Button asChild variant="secondary"><Link href="/security">Security &amp; compliance</Link></Button>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
