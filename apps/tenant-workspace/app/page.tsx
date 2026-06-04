import Link from 'next/link';
import { Button, Card } from '@projexlight/design-system';
import { MarketingHeader } from '../components/MarketingHeader';
import { MarketingFooter } from '../components/MarketingFooter';

/**
 * Public landing page. Replaces the original prototype CTA-only page.
 * Visitors here are pre-trial: developers evaluating SDKs, founders looking
 * for compliance-built-in, or operators sizing up the platform.
 */

const SECTION_TITLE = 'text-center text-3xl font-bold tracking-tight';
const SECTION_SUB = 'mx-auto mb-10 max-w-2xl text-center text-base text-muted-foreground';

const PILLARS = [
  {
    title: 'Identity, properly modeled',
    body: 'Six-layer JWT: Master Person · App Identity · Tenant Membership · Persona · Encounter · Relationship. Every API call is filtered through the scope on the token — multi-tenant by design, not by convention.',
  },
  {
    title: 'Customer holds the keys',
    body: "BYOK / CMEK via AWS KMS, GCP KMS, or HSM. Revoke the grant on your KMS → this tenant's data is undecryptable platform-wide within 30s. The kill-switch your auditors keep asking about.",
  },
  {
    title: 'AI Gateway, governed',
    body: 'OpenAI, Anthropic, Bedrock, Gemini behind one endpoint. PII redaction, per-tenant routing, soft-cap + hard-cap budgets, Langfuse traces. Bring your own AI provider keys is rolling out Q3 2026.',
  },
  {
    title: 'Audit that survives a courtroom',
    body: 'Append-only ledger with SHA-256 hash chain per tenant. Every admin-side action lands here automatically. Verify the chain on demand; export to PDF or JSON for compliance review.',
  },
  {
    title: 'Vertical packs, not toolkits',
    body: 'Healthcare, FinServ, RevOps, Field-service, Public Sector. Each pack composes pre-tested SDKs with compliance attestations and a working starter app. Pick a pack at signup, ship in a week.',
  },
  {
    title: 'AI build, not boilerplate',
    body: 'Describe what you want in plain English at /build; the cloud agent matches your prompt to a vertical blueprint, asks two or three clarifying questions, and scaffolds a working app inside your tenant pool.',
  },
];

const STATS = [
  { num: '70+', label: 'Production SDKs' },
  { num: '4', label: 'AI providers wired' },
  { num: '5', label: 'Vertical packs at launch' },
  { num: '99.99%', label: 'Enterprise uptime SLA' },
];

export default function Home(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />

      <section className="bg-gradient-to-b from-background to-muted px-8 pb-16 pt-24 text-center">
        <h1 className="mx-auto mb-4 max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Ship multi-tenant SaaS in days, not quarters.
        </h1>
        <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          ProjexCloud is the platform behind your platform — identity, billing, audit, AI,
          and compliance, pre-wired. 70+ production SDKs, vertical packs for healthcare,
          finance, and field service. Customer holds the encryption keys. You ship features.
        </p>
        <div className="flex justify-center gap-3">
          <Button asChild size="lg"><Link href="/signup">Start free trial</Link></Button>
          <Button asChild size="lg" variant="secondary"><Link href="/features">See what&apos;s included</Link></Button>
        </div>
        <p className="mt-5 text-xs text-muted-foreground">
          14-day trial · no credit card · self-serve provisioning
        </p>
      </section>

      <section className="border-t px-8 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className={SECTION_TITLE}>Built for the work your customers actually pay for</h2>
          <p className={`${SECTION_SUB} mt-3`}>
            Six-layer identity, customer-managed encryption, an append-only audit chain,
            a metered AI gateway across four providers, and a meter that&apos;s already
            on the customer&apos;s invoice. Pick the pieces you need; the rest is opt-in.
          </p>

          <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
            {PILLARS.map((p) => (
              <Card key={p.title} className="p-6">
                <div className="mb-2 text-base font-semibold">{p.title}</div>
                <p className="text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </Card>
            ))}
          </div>

          <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            {STATS.map((s) => (
              <div key={s.label} className="px-2 py-4 text-center">
                <div className="text-4xl font-bold tracking-tight">{s.num}</div>
                <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-muted px-8 py-[72px]">
        <div className="mx-auto max-w-6xl text-center">
          <h2 className={SECTION_TITLE}>Pricing that scales with your usage</h2>
          <p className={`${SECTION_SUB} mt-3`}>
            Three tiers — Starter for evaluation, Pro for production, Enterprise for
            regulated and sovereign deployments. AI tokens metered separately at
            cost-plus; BYOK for AI keys puts that line on your provider invoice instead.
          </p>
          <div className="flex justify-center gap-3">
            <Button asChild size="lg"><Link href="/pricing">See pricing</Link></Button>
            <Button asChild size="lg" variant="secondary"><Link href="/security">Compliance &amp; security</Link></Button>
          </div>
        </div>
      </section>

      <section className="px-8 py-[72px] text-center">
        <h2 className={SECTION_TITLE}>Try it on your own infrastructure in 5 minutes</h2>
        <p className={`${SECTION_SUB} mt-3`}>
          Self-serve signup creates a tenant, mints a six-layer JWT, and drops you on
          a working dashboard. Already on the platform? Sign in.
        </p>
        <div className="flex justify-center gap-3">
          <Button asChild size="lg"><Link href="/signup">Start free trial</Link></Button>
          <Button asChild size="lg" variant="secondary"><Link href="/login">Sign in</Link></Button>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
