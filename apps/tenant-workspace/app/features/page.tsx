import Link from 'next/link';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 980, margin: '0 auto', padding: '0 32px' };

const PAGE_HERO: React.CSSProperties = { padding: '72px 32px 32px', textAlign: 'center', background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)' };
const H1: React.CSSProperties = { fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 auto 12px', maxWidth: 720 };
const SUB: React.CSSProperties = { fontSize: 18, color: '#5a6573', maxWidth: 680, margin: '0 auto 0', lineHeight: 1.55 };

const SECTION: React.CSSProperties = { padding: '56px 32px', borderTop: '1px solid #eef1f6' };
const SECTION_HEAD: React.CSSProperties = { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 24, marginBottom: 24, alignItems: 'baseline' };
const SECTION_TAG: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#1a4fc4', textTransform: 'uppercase', letterSpacing: '0.06em' };
const SECTION_TITLE: React.CSSProperties = { fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', margin: 0 };
const SECTION_BODY: React.CSSProperties = { fontSize: 15, color: '#1b2a44', lineHeight: 1.65, marginLeft: 204 };
const SECTION_BULLETS: React.CSSProperties = { marginLeft: 204, marginTop: 16, paddingLeft: 18, fontSize: 14, color: '#1b2a44', lineHeight: 1.7 };

const BADGE: React.CSSProperties = {
  display: 'inline-block', fontSize: 11, fontWeight: 600,
  background: '#fdf6e3', color: '#9a6e00', padding: '2px 8px',
  borderRadius: 999, marginLeft: 8, verticalAlign: 'middle',
  border: '1px solid #e3c47b', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const CTA_ROW: React.CSSProperties = { display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24 };
const CTA_PRIMARY: React.CSSProperties = { background: '#0b1220', color: '#fff', padding: '12px 24px', borderRadius: 6, textDecoration: 'none', fontSize: 15, fontWeight: 600 };
const CTA_SECONDARY: React.CSSProperties = { background: '#fff', color: '#0b1220', padding: '12px 24px', borderRadius: 6, textDecoration: 'none', fontSize: 15, fontWeight: 500, border: '1px solid #d7dce4' };

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
    <div style={WRAP}>
      <MarketingHeader />

      <section style={PAGE_HERO}>
        <h1 style={H1}>Features</h1>
        <p style={SUB}>
          Everything you need to ship multi-tenant SaaS without rebuilding the
          plumbing every quarter. Pick what you use; the rest is opt-in.
        </p>
      </section>

      {FEATURES.map((f) => (
        <section key={f.tag} style={SECTION}>
          <div style={{ ...CONTAINER }}>
            <div style={SECTION_HEAD}>
              <div style={SECTION_TAG}>{f.tag}</div>
              <h2 style={SECTION_TITLE}>
                {f.title}
                {f.badge && <span style={BADGE}>{f.badge}</span>}
              </h2>
            </div>
            <p style={SECTION_BODY}>{f.body}</p>
            <ul style={SECTION_BULLETS}>
              {f.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        </section>
      ))}

      <section style={{ padding: '64px 32px', background: '#f5f9ff', textAlign: 'center' }}>
        <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 12 }}>
          Ready to try it?
        </h2>
        <p style={{ fontSize: 16, color: '#5a6573', maxWidth: 600, margin: '0 auto 8px' }}>
          14-day free trial, no credit card. See <Link href="/pricing">pricing</Link>{' '}
          or read <a href="/docs/user/tenant-getting-started.html">getting started</a>.
        </p>
        <div style={CTA_ROW}>
          <Link href="/signup"   style={CTA_PRIMARY}>Start free trial</Link>
          <Link href="/security" style={CTA_SECONDARY}>Security &amp; compliance</Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
