import Link from 'next/link';
import { Button, Card } from '@projexlight/design-system';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

const SECTION = 'border-t px-8 py-10';
const CONTAINER = 'mx-auto max-w-3xl';
const H2 = 'mb-3 text-2xl font-bold tracking-tight';
const BODY = 'mb-4 text-[15px] leading-relaxed';
const BULLETS = 'list-disc space-y-1 pl-5 text-sm leading-relaxed';
const CALLOUT =
  'mt-4 rounded border border-warning/40 border-l-[3px] border-l-warning bg-warning/10 px-4 py-3.5 text-sm';

const POSTURE: Array<{ name: string; status: string; live: boolean }> = [
  { name: 'SOC 2 Type II', status: 'In progress — letter of attestation on request', live: false },
  { name: 'ISO 27001', status: 'In progress', live: false },
  { name: 'HIPAA BAA', status: 'Available on Pro and Enterprise', live: true },
  { name: 'GDPR / UK GDPR', status: 'DPA available on request', live: true },
  { name: 'DPDP (India)', status: 'Supported by sdk-data-rights', live: true },
  { name: 'FedRAMP-Moderate', status: 'Roadmap — Q3 2026', live: false },
  { name: 'StateRAMP', status: 'Roadmap — Q3 2026', live: false },
  { name: 'PCI-DSS', status: 'Out of scope (we do not store cardholder data)', live: true },
];

export default function SecurityPage(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />

      <section className="bg-gradient-to-b from-background to-muted px-8 pb-8 pt-[72px] text-center">
        <h1 className="mx-auto mb-3 max-w-xl text-4xl font-bold tracking-tight">Security &amp; compliance</h1>
        <p className="mx-auto max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          The platform is designed so the customer holds the keys, the chain is verifiable,
          and the audit trail outlives the engineers who wrote it. What follows is the
          shape of the platform — not a promise of certification.
        </p>
      </section>

      <section className={SECTION}>
        <div className={CONTAINER}>
          <h2 className={H2}>Customer-managed encryption (BYOK / CMEK)</h2>
          <p className={BODY}>
            Every tenant has its own Tenant Key in the platform vault. On Pro
            and Enterprise tiers, the Tenant Key envelope is wrapped by a
            <strong> customer-managed key (CMK)</strong> in your AWS KMS, GCP KMS,
            or HSM (PKCS#11). The platform never holds raw key material; every
            decryption call hits your KMS first.
          </p>
          <ul className={BULLETS}>
            <li>Four-tier vault: Platform KEK → Tenant KEK → DEKs → Per-resource keys.</li>
            <li>Revoke the grant on your CMK and this tenant&apos;s data becomes undecryptable platform-wide within ~30s. Documented kill-switch.</li>
            <li>SIEM forwarder for all key-usage events so your SOC sees them live.</li>
            <li>Cryptographic shredding for right-to-be-forgotten and time-bound retention.</li>
          </ul>
          <div className={CALLOUT}>
            <strong>BYOK for AI provider keys</strong> — separate from CMEK — is on the Q3
            2026 roadmap. Today, AI completions route through platform-held provider
            keys; tenant-held provider keys are in flight under epic <code>76ec75df</code>.
          </div>
        </div>
      </section>

      <section className={SECTION}>
        <div className={CONTAINER}>
          <h2 className={H2}>Audit chain</h2>
          <p className={BODY}>
            Every admin-side action, every credential lifecycle event, every AI
            completion, every consent change appends to a per-tenant
            SHA-256-chained ledger. Chains are verified on a configurable
            cadence; chain breaks emit <code>audit.chain.break.v1</code> events.
            Three retention classes apply automatically — transient (7d),
            operational (90d), regulated (7y).
          </p>
          <ul className={BULLETS}>
            <li>Per-tenant chain heads so a regional incident doesn&apos;t cascade across tenants.</li>
            <li>Hash-chain proof export (PDF or JSON) for compliance review.</li>
            <li>Trace IDs cross-link audit rows to Langfuse, OpenTelemetry, and provider invoices.</li>
            <li>Tamper detection via the background verifier scheduler; alarms on break.</li>
          </ul>
        </div>
      </section>

      <section className={SECTION}>
        <div className={CONTAINER}>
          <h2 className={H2}>Identity &amp; access</h2>
          <p className={BODY}>
            Every JWT carries a six-layer scope (Master Person, App Identity,
            Tenant Membership, Persona, Encounter, Relationship). Every API
            call is filtered through those scopes — there&apos;s no path to
            another tenant&apos;s data, even by accident. The signing key
            rotates quarterly; old tokens drain through a 10-minute grace
            window so you don&apos;t outage on rotation.
          </p>
          <ul className={BULLETS}>
            <li>Social IdP (Google, Microsoft, Apple), SAML SP, SCIM 2.0 provisioning.</li>
            <li>MFA challenge, step-up auth on sensitive operations.</li>
            <li>Impersonation grants require approver + reason; emit a regulated-class audit event.</li>
            <li>Three-evaluator policy mesh (consent, ReBAC, RBAC) decides every authorize call.</li>
          </ul>
        </div>
      </section>

      <section className={SECTION}>
        <div className={CONTAINER}>
          <h2 className={H2}>Deployment posture</h2>
          <p className={BODY}>
            Shared multi-region for Starter and Pro; sovereign regions and
            air-gapped on-prem for Enterprise. No customer data crosses a
            region boundary without an explicit data-residency event.
          </p>
          <ul className={BULLETS}>
            <li>Pool-based horizontal scaling — no sharding, no manual capacity planning.</li>
            <li>Active-active multi-region with chaos drills as a first-class operation.</li>
            <li>Sovereign region pinning (EU, UK, FedRAMP, StateRAMP, IL5, PIPL).</li>
            <li>Air-gapped on-prem bundles with rollback support and local-LLM provider resolver.</li>
            <li>99.9% uptime on Pro, 99.99% on Enterprise with custom MTTR.</li>
          </ul>
        </div>
      </section>

      <section className={SECTION}>
        <div className={CONTAINER}>
          <h2 className={H2}>Compliance posture</h2>
          <p className={BODY}>
            What we have today, what&apos;s in progress, and what&apos;s honestly on the roadmap.
            We do not claim attestations we do not yet hold. Request a letter of attestation
            via your account team for the latest signed statement.
          </p>
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {POSTURE.map((p) => (
              <Card key={p.name} className="p-4 text-sm">
                <div className="mb-1.5 font-semibold">
                  {p.name}
                  <span className={`ml-2 text-[11px] font-semibold ${p.live ? 'text-success' : 'text-warning-foreground'}`}>
                    {p.live ? '● Live' : '○ In progress / roadmap'}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{p.status}</div>
              </Card>
            ))}
          </div>
          <div className={CALLOUT}>
            <strong>Forward-looking statements.</strong> Items marked &quot;in progress&quot; and
            &quot;roadmap&quot; are not current certifications. Contact{' '}
            <a href="mailto:compliance@projexcloud.com" className="text-primary underline">compliance@projexcloud.com</a>{' '}
            for the current letter of attestation before relying on them in procurement.
          </div>
        </div>
      </section>

      <section className="bg-primary px-8 py-16 text-center text-primary-foreground">
        <h2 className="mb-3 text-2xl font-bold tracking-tight">Have a procurement security review?</h2>
        <p className="mx-auto mb-6 max-w-xl text-[15px] text-primary-foreground/70">
          Send us your SIG questionnaire / CAIQ / vendor security review. We&apos;ll get a
          signed response back within 5 business days.
        </p>
        <Button asChild size="lg" variant="secondary">
          <a href="mailto:compliance@projexcloud.com">Contact compliance</a>
        </Button>
        <p className="mt-6 text-xs text-primary-foreground/60">
          Or jump to <Link href="/pricing" className="underline">pricing</Link>{' '}
          to see what tier covers your compliance bar.
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
