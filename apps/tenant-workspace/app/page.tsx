import Link from 'next/link';
import { MarketingHeader } from '../components/MarketingHeader';
import { MarketingFooter } from '../components/MarketingFooter';

/**
 * Public landing page. Replaces the original prototype CTA-only page.
 * Visitors here are pre-trial: developers evaluating SDKs, founders looking
 * for compliance-built-in, or operators sizing up the platform.
 */

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 1100, margin: '0 auto', padding: '0 32px' };

const HERO: React.CSSProperties = {
  padding: '88px 32px 64px',
  background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)',
  textAlign: 'center',
};

const H1: React.CSSProperties = {
  fontSize: 52, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1,
  margin: '0 auto 16px', maxWidth: 820,
};

const SUB: React.CSSProperties = {
  fontSize: 19, color: '#5a6573', maxWidth: 720, margin: '0 auto 32px', lineHeight: 1.55,
};

const CTA_ROW: React.CSSProperties = { display: 'flex', gap: 12, justifyContent: 'center', marginTop: 8 };

const CTA_PRIMARY: React.CSSProperties = {
  background: '#0b1220', color: '#fff', padding: '14px 28px', borderRadius: 8,
  textDecoration: 'none', fontSize: 16, fontWeight: 600,
};
const CTA_SECONDARY: React.CSSProperties = {
  background: '#fff', color: '#0b1220', padding: '14px 28px', borderRadius: 8,
  textDecoration: 'none', fontSize: 16, fontWeight: 500, border: '1px solid #d7dce4',
};

const SECTION_TITLE: React.CSSProperties = {
  fontSize: 32, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 12, textAlign: 'center',
};
const SECTION_SUB: React.CSSProperties = {
  fontSize: 16, color: '#5a6573', textAlign: 'center', maxWidth: 720, margin: '0 auto 40px',
};

const PILL_GRID: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16, marginTop: 24,
};

const PILL_CARD: React.CSSProperties = {
  padding: 24, border: '1px solid #e3e8f0', borderRadius: 12, background: '#fff',
};

const PILL_TITLE: React.CSSProperties = { fontSize: 17, fontWeight: 600, marginBottom: 8 };
const PILL_BODY: React.CSSProperties = { fontSize: 14, color: '#5a6573', lineHeight: 1.55 };

const STAT_ROW: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 16, marginTop: 48,
};
const STAT_CARD: React.CSSProperties = { textAlign: 'center', padding: '16px 8px' };
const STAT_NUM: React.CSSProperties = { fontSize: 36, fontWeight: 700, color: '#1b2a44', letterSpacing: '-0.02em' };
const STAT_LBL: React.CSSProperties = { fontSize: 13, color: '#7a8597', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };

export default function Home(): JSX.Element {
  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={HERO}>
        <h1 style={H1}>
          Ship multi-tenant SaaS in days, not quarters.
        </h1>
        <p style={SUB}>
          ProjexCloud is the platform behind your platform — identity, billing, audit, AI,
          and compliance, pre-wired. 70+ production SDKs, vertical packs for healthcare,
          finance, and field service. Customer holds the encryption keys. You ship features.
        </p>
        <div style={CTA_ROW}>
          <Link href="/signup"   style={CTA_PRIMARY}>Start free trial</Link>
          <Link href="/features" style={CTA_SECONDARY}>See what&apos;s included</Link>
        </div>
        <p style={{ marginTop: 20, fontSize: 13, color: '#7a8597' }}>
          14-day trial · no credit card · self-serve provisioning
        </p>
      </section>

      <section style={{ padding: '64px 32px', borderTop: '1px solid #eef1f6' }}>
        <div style={CONTAINER}>
          <h2 style={SECTION_TITLE}>Built for the work your customers actually pay for</h2>
          <p style={SECTION_SUB}>
            Six-layer identity, customer-managed encryption, an append-only audit chain,
            a metered AI gateway across four providers, and a meter that&apos;s already
            on the customer&apos;s invoice. Pick the pieces you need; the rest is opt-in.
          </p>

          <div style={PILL_GRID}>
            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>Identity, properly modeled</div>
              <div style={PILL_BODY}>
                Six-layer JWT: Master Person · App Identity · Tenant Membership · Persona ·
                Encounter · Relationship. Every API call is filtered through the scope on
                the token — multi-tenant by design, not by convention.
              </div>
            </div>

            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>Customer holds the keys</div>
              <div style={PILL_BODY}>
                BYOK / CMEK via AWS KMS, GCP KMS, or HSM. Revoke the grant on your KMS →
                this tenant&apos;s data is undecryptable platform-wide within 30s. The
                kill-switch your auditors keep asking about.
              </div>
            </div>

            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>AI Gateway, governed</div>
              <div style={PILL_BODY}>
                OpenAI, Anthropic, Bedrock, Gemini behind one endpoint. PII redaction,
                per-tenant routing, soft-cap + hard-cap budgets, Langfuse traces.
                Bring your own AI provider keys is rolling out Q3 2026.
              </div>
            </div>

            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>Audit that survives a courtroom</div>
              <div style={PILL_BODY}>
                Append-only ledger with SHA-256 hash chain per tenant. Every
                admin-side action lands here automatically. Verify the chain on
                demand; export to PDF or JSON for compliance review.
              </div>
            </div>

            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>Vertical packs, not toolkits</div>
              <div style={PILL_BODY}>
                Healthcare, FinServ, RevOps, Field-service, Public Sector. Each
                pack composes pre-tested SDKs with compliance attestations and a
                working starter app. Pick a pack at signup, ship in a week.
              </div>
            </div>

            <div style={PILL_CARD}>
              <div style={PILL_TITLE}>AI build, not boilerplate</div>
              <div style={PILL_BODY}>
                Describe what you want in plain English at <code>/build</code>; the
                cloud agent matches your prompt to a vertical blueprint, asks two
                or three clarifying questions, and scaffolds a working app inside
                your tenant pool.
              </div>
            </div>
          </div>

          <div style={STAT_ROW}>
            <div style={STAT_CARD}>
              <div style={STAT_NUM}>70+</div>
              <div style={STAT_LBL}>Production SDKs</div>
            </div>
            <div style={STAT_CARD}>
              <div style={STAT_NUM}>4</div>
              <div style={STAT_LBL}>AI providers wired</div>
            </div>
            <div style={STAT_CARD}>
              <div style={STAT_NUM}>5</div>
              <div style={STAT_LBL}>Vertical packs at launch</div>
            </div>
            <div style={STAT_CARD}>
              <div style={STAT_NUM}>99.99%</div>
              <div style={STAT_LBL}>Enterprise uptime SLA</div>
            </div>
          </div>
        </div>
      </section>

      <section style={{ padding: '72px 32px', background: '#f5f9ff' }}>
        <div style={{ ...CONTAINER, textAlign: 'center' }}>
          <h2 style={SECTION_TITLE}>Pricing that scales with your usage</h2>
          <p style={SECTION_SUB}>
            Three tiers — Starter for evaluation, Pro for production, Enterprise for
            regulated and sovereign deployments. AI tokens metered separately at
            cost-plus; BYOK for AI keys puts that line on your provider invoice instead.
          </p>
          <div style={CTA_ROW}>
            <Link href="/pricing" style={CTA_PRIMARY}>See pricing</Link>
            <Link href="/security" style={CTA_SECONDARY}>Compliance &amp; security</Link>
          </div>
        </div>
      </section>

      <section style={{ padding: '72px 32px', textAlign: 'center' }}>
        <h2 style={SECTION_TITLE}>Try it on your own infrastructure in 5 minutes</h2>
        <p style={SECTION_SUB}>
          Self-serve signup creates a tenant, mints a six-layer JWT, and drops you on
          a working dashboard. Already on the platform? Sign in.
        </p>
        <div style={CTA_ROW}>
          <Link href="/signup" style={CTA_PRIMARY}>Start free trial</Link>
          <Link href="/login"  style={CTA_SECONDARY}>Sign in</Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
