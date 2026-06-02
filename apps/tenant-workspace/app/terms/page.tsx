import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';
import { LegalDraftBanner } from '../../components/LegalDraftBanner';

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 880, margin: '0 auto', padding: '32px 32px 80px' };
const H1: React.CSSProperties = { fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8 };
const META: React.CSSProperties = { fontSize: 13, color: '#7a8597', marginBottom: 32 };
const H2: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginTop: 32, marginBottom: 12 };
const P: React.CSSProperties = { fontSize: 15, color: '#1b2a44', lineHeight: 1.7, marginBottom: 12 };

export default function TermsPage(): JSX.Element {
  return (
    <div style={WRAP}>
      <MarketingHeader />
      <div style={CONTAINER}>
        <LegalDraftBanner docName="Terms of Service" />
        <h1 style={H1}>Terms of Service</h1>
        <p style={META}>Last updated: TBD — DRAFT</p>

        <h2 style={H2}>1. Acceptance of Terms</h2>
        <p style={P}>
          By creating an account or using the ProjexCloud platform (the &quot;Service&quot;),
          you agree to be bound by these Terms of Service (&quot;Terms&quot;). If you are
          accepting these Terms on behalf of an organization, you represent that you have
          authority to bind that organization to these Terms.
        </p>

        <h2 style={H2}>2. Description of Service</h2>
        <p style={P}>
          ProjexCloud provides a multi-tenant SaaS platform with identity, billing, audit,
          AI gateway, and vertical-application primitives, accessible via web portals,
          APIs, CLIs, and AI tooling integrations. The Service includes both
          self-serve tiers (Starter, Pro) and contracted Enterprise tiers.
        </p>

        <h2 style={H2}>3. Account &amp; Tenant Responsibilities</h2>
        <p style={P}>
          You are responsible for safeguarding the credentials you use to access the
          Service, for activity performed under your tenant, and for compliance with
          all applicable laws in your jurisdiction. Tenant admins are responsible for
          provisioning, deprovisioning, and managing personas within their tenant.
        </p>

        <h2 style={H2}>4. Acceptable Use</h2>
        <p style={P}>
          You agree not to (a) reverse-engineer the Service except as permitted by law,
          (b) use the Service to transmit unlawful, harmful, or infringing content,
          (c) circumvent metering, rate limits, or compliance controls, or (d) use
          the Service to compete with ProjexCloud&apos;s platform offering.
        </p>

        <h2 style={H2}>5. Fees &amp; Billing</h2>
        <p style={P}>
          Pricing for Starter and Pro tiers is set forth on the pricing page and may
          be adjusted with 30 days&apos; notice. Enterprise pricing is set forth in
          your contract. AI provider tokens, storage, data egress, and other metered
          resources are billed as usage in addition to the tier base price.
        </p>

        <h2 style={H2}>6. Data Ownership &amp; Privacy</h2>
        <p style={P}>
          You retain all rights, title, and interest in the data you submit to the
          Service. Our privacy obligations are set forth in the Privacy Policy and,
          for tenants subject to GDPR/UK GDPR/DPDP, the Data Processing Agreement.
        </p>

        <h2 style={H2}>7. Security &amp; Compliance</h2>
        <p style={P}>
          ProjexCloud maintains the security posture described on the Security page,
          including encryption, audit logging, and the customer-managed key (BYOK/CMEK)
          option for tenants on Pro and Enterprise tiers. Forward-looking compliance
          statements (e.g., &quot;in progress&quot;) are not guarantees of certification.
        </p>

        <h2 style={H2}>8. Term &amp; Termination</h2>
        <p style={P}>
          These Terms remain in effect for as long as you use the Service. ProjexCloud
          may suspend or terminate access for material breach. On termination, ProjexCloud
          will retain your data for a configurable export window and then delete it per
          the audit retention policy and the Privacy Policy.
        </p>

        <h2 style={H2}>9. Warranty Disclaimers &amp; Limitation of Liability</h2>
        <p style={P}>
          [DRAFT — legal-team standard limitation-of-liability language here.]
        </p>

        <h2 style={H2}>10. Governing Law</h2>
        <p style={P}>
          [DRAFT — choice of law / forum to be finalised by counsel.]
        </p>

        <h2 style={H2}>11. Changes to These Terms</h2>
        <p style={P}>
          We may update these Terms from time to time. Material changes will be
          notified to tenant admins by email and surfaced in the tenant-admin
          console at least 30 days before they take effect.
        </p>

        <p style={{ ...P, marginTop: 32, fontStyle: 'italic', color: '#5a6573' }}>
          Questions? <a href="mailto:legal@projexcloud.com">legal@projexcloud.com</a>
        </p>
      </div>
      <MarketingFooter />
    </div>
  );
}
