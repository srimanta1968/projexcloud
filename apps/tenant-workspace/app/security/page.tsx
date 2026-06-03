import Link from 'next/link';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 920, margin: '0 auto', padding: '0 32px' };

const PAGE_HERO: React.CSSProperties = { padding: '72px 32px 32px', textAlign: 'center', background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)' };
const H1: React.CSSProperties = { fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 auto 12px', maxWidth: 680 };
const SUB: React.CSSProperties = { fontSize: 17, color: '#5a6573', maxWidth: 680, margin: '0 auto 0', lineHeight: 1.55 };

const SECTION: React.CSSProperties = { padding: '40px 32px', borderTop: '1px solid #eef1f6' };
const H2: React.CSSProperties = { fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', margin: '0 0 12px' };
const BODY: React.CSSProperties = { fontSize: 15, color: '#1b2a44', lineHeight: 1.7, marginBottom: 16 };
const BULLETS: React.CSSProperties = { fontSize: 14, color: '#1b2a44', lineHeight: 1.8, paddingLeft: 20 };

const POSTURE_GRID: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 16,
};
const POSTURE_CARD: React.CSSProperties = {
  padding: 16, border: '1px solid #d7dce4', borderRadius: 8, background: '#fff', fontSize: 14,
};
const POSTURE_NAME: React.CSSProperties = { fontWeight: 600, marginBottom: 6, color: '#1b2a44', fontSize: 14 };
const POSTURE_STATUS: React.CSSProperties = { fontSize: 13, color: '#5a6573' };

const CALLOUT: React.CSSProperties = {
  background: '#fdf6e3', border: '1px solid #e3c47b', borderLeft: '3px solid #c79100',
  padding: '14px 18px', borderRadius: 4, fontSize: 14, marginTop: 16, color: '#5a4a08',
};

const POSTURE: Array<{ name: string; status: string; live: boolean }> = [
  { name: 'SOC 2 Type II',           status: 'In progress — letter of attestation on request', live: false },
  { name: 'ISO 27001',               status: 'In progress', live: false },
  { name: 'HIPAA BAA',               status: 'Available on Pro and Enterprise', live: true },
  { name: 'GDPR / UK GDPR',          status: 'DPA available on request',         live: true },
  { name: 'DPDP (India)',            status: 'Supported by sdk-data-rights',      live: true },
  { name: 'FedRAMP-Moderate',        status: 'Roadmap — Q3 2026',                 live: false },
  { name: 'StateRAMP',               status: 'Roadmap — Q3 2026',                 live: false },
  { name: 'PCI-DSS',                 status: 'Out of scope (we do not store cardholder data)', live: true },
];

export default function SecurityPage(): JSX.Element {
  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={PAGE_HERO}>
        <h1 style={H1}>Security &amp; compliance</h1>
        <p style={SUB}>
          The platform is designed so the customer holds the keys, the chain is verifiable,
          and the audit trail outlives the engineers who wrote it. What follows is the
          shape of the platform — not a promise of certification.
        </p>
      </section>

      <section style={SECTION}>
        <div style={CONTAINER}>
          <h2 style={H2}>Customer-managed encryption (BYOK / CMEK)</h2>
          <p style={BODY}>
            Every tenant has its own Tenant Key in the platform vault. On Pro
            and Enterprise tiers, the Tenant Key envelope is wrapped by a
            <strong> customer-managed key (CMK)</strong> in your AWS KMS, GCP KMS,
            or HSM (PKCS#11). The platform never holds raw key material; every
            decryption call hits your KMS first.
          </p>
          <ul style={BULLETS}>
            <li>Four-tier vault: Platform KEK → Tenant KEK → DEKs → Per-resource keys.</li>
            <li>Revoke the grant on your CMK and this tenant&apos;s data becomes undecryptable platform-wide within ~30s. Documented kill-switch.</li>
            <li>SIEM forwarder for all key-usage events so your SOC sees them live.</li>
            <li>Cryptographic shredding for right-to-be-forgotten and time-bound retention.</li>
          </ul>
          <div style={CALLOUT}>
            <strong>BYOK for AI provider keys</strong> — separate from CMEK — is on the Q3
            2026 roadmap. Today, AI completions route through platform-held provider
            keys; tenant-held provider keys are in flight under epic <code>76ec75df</code>.
          </div>
        </div>
      </section>

      <section style={SECTION}>
        <div style={CONTAINER}>
          <h2 style={H2}>Audit chain</h2>
          <p style={BODY}>
            Every admin-side action, every credential lifecycle event, every AI
            completion, every consent change appends to a per-tenant
            SHA-256-chained ledger. Chains are verified on a configurable
            cadence; chain breaks emit <code>audit.chain.break.v1</code> events.
            Three retention classes apply automatically — transient (7d),
            operational (90d), regulated (7y).
          </p>
          <ul style={BULLETS}>
            <li>Per-tenant chain heads so a regional incident doesn&apos;t cascade across tenants.</li>
            <li>Hash-chain proof export (PDF or JSON) for compliance review.</li>
            <li>Trace IDs cross-link audit rows to Langfuse, OpenTelemetry, and provider invoices.</li>
            <li>Tamper detection via the background verifier scheduler; alarms on break.</li>
          </ul>
        </div>
      </section>

      <section style={SECTION}>
        <div style={CONTAINER}>
          <h2 style={H2}>Identity &amp; access</h2>
          <p style={BODY}>
            Every JWT carries a six-layer scope (Master Person, App Identity,
            Tenant Membership, Persona, Encounter, Relationship). Every API
            call is filtered through those scopes — there&apos;s no path to
            another tenant&apos;s data, even by accident. The signing key
            rotates quarterly; old tokens drain through a 10-minute grace
            window so you don&apos;t outage on rotation.
          </p>
          <ul style={BULLETS}>
            <li>Social IdP (Google, Microsoft, Apple), SAML SP, SCIM 2.0 provisioning.</li>
            <li>MFA challenge, step-up auth on sensitive operations.</li>
            <li>Impersonation grants require approver + reason; emit a regulated-class audit event.</li>
            <li>Three-evaluator policy mesh (consent, ReBAC, RBAC) decides every authorize call.</li>
          </ul>
        </div>
      </section>

      <section style={SECTION}>
        <div style={CONTAINER}>
          <h2 style={H2}>Deployment posture</h2>
          <p style={BODY}>
            Shared multi-region for Starter and Pro; sovereign regions and
            air-gapped on-prem for Enterprise. No customer data crosses a
            region boundary without an explicit data-residency event.
          </p>
          <ul style={BULLETS}>
            <li>Pool-based horizontal scaling — no sharding, no manual capacity planning.</li>
            <li>Active-active multi-region with chaos drills as a first-class operation.</li>
            <li>Sovereign region pinning (EU, UK, FedRAMP, StateRAMP, IL5, PIPL).</li>
            <li>Air-gapped on-prem bundles with rollback support and local-LLM provider resolver.</li>
            <li>99.9% uptime on Pro, 99.99% on Enterprise with custom MTTR.</li>
          </ul>
        </div>
      </section>

      <section style={SECTION}>
        <div style={CONTAINER}>
          <h2 style={H2}>Compliance posture</h2>
          <p style={BODY}>
            What we have today, what&apos;s in progress, and what&apos;s honestly on the roadmap.
            We do not claim attestations we do not yet hold. Request a letter of attestation
            via your account team for the latest signed statement.
          </p>
          <div style={POSTURE_GRID}>
            {POSTURE.map((p) => (
              <div key={p.name} style={POSTURE_CARD}>
                <div style={POSTURE_NAME}>
                  {p.name}
                  <span style={{ marginLeft: 8, fontSize: 11, color: p.live ? '#0d8a3d' : '#9a6e00', fontWeight: 600 }}>
                    {p.live ? '● Live' : '○ In progress / roadmap'}
                  </span>
                </div>
                <div style={POSTURE_STATUS}>{p.status}</div>
              </div>
            ))}
          </div>
          <div style={CALLOUT}>
            <strong>Forward-looking statements.</strong> Items marked &quot;in progress&quot; and
            &quot;roadmap&quot; are not current certifications. Contact{' '}
            <a href="mailto:compliance@projexcloud.com">compliance@projexcloud.com</a>{' '}
            for the current letter of attestation before relying on them in procurement.
          </div>
        </div>
      </section>

      <section style={{ padding: '64px 32px', background: '#0b1220', color: '#f0f3f9', textAlign: 'center' }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 12 }}>
          Have a procurement security review?
        </h2>
        <p style={{ fontSize: 15, color: '#a4afc4', maxWidth: 600, margin: '0 auto 24px' }}>
          Send us your SIG questionnaire / CAIQ / vendor security review. We&apos;ll get a
          signed response back within 5 business days.
        </p>
        <a href="mailto:compliance@projexcloud.com" style={{ background: '#fff', color: '#0b1220', padding: '14px 28px', borderRadius: 8, textDecoration: 'none', fontSize: 16, fontWeight: 600 }}>
          Contact compliance
        </a>
        <p style={{ marginTop: 24, fontSize: 13, color: '#7a8597' }}>
          Or jump to <Link href="/pricing" style={{ color: '#a4afc4' }}>pricing</Link>{' '}
          to see what tier covers your compliance bar.
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
