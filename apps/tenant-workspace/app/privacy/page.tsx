import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';
import { LegalDraftBanner } from '../../components/LegalDraftBanner';

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 880, margin: '0 auto', padding: '32px 32px 80px' };
const H1: React.CSSProperties = { fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8 };
const META: React.CSSProperties = { fontSize: 13, color: '#7a8597', marginBottom: 32 };
const H2: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginTop: 32, marginBottom: 12 };
const P: React.CSSProperties = { fontSize: 15, color: '#1b2a44', lineHeight: 1.7, marginBottom: 12 };
const UL: React.CSSProperties = { fontSize: 15, color: '#1b2a44', lineHeight: 1.7, paddingLeft: 22, marginBottom: 12 };

export default function PrivacyPage(): JSX.Element {
  return (
    <div style={WRAP}>
      <MarketingHeader />
      <div style={CONTAINER}>
        <LegalDraftBanner docName="Privacy Policy" />
        <h1 style={H1}>Privacy Policy</h1>
        <p style={META}>Last updated: TBD — DRAFT</p>

        <h2 style={H2}>1. Overview</h2>
        <p style={P}>
          This Privacy Policy explains how ProjexCloud Inc. (&quot;we&quot;, &quot;us&quot;)
          collects, uses, and shares information when you visit projexcloud.com, sign up
          for an account, or use the Service. For tenants subject to GDPR, UK GDPR, or
          DPDP, the Data Processing Agreement supplements this Policy.
        </p>

        <h2 style={H2}>2. Information We Collect</h2>
        <ul style={UL}>
          <li><strong>Account data:</strong> email, name, company, password hash, MFA factors.</li>
          <li><strong>Tenant data:</strong> content you upload, configure, or process via the Service.</li>
          <li><strong>Usage data:</strong> API call metadata, audit ledger rows, meter events, traces.</li>
          <li><strong>Device data:</strong> IP, user agent, device fingerprint for fraud detection.</li>
          <li><strong>Payment data:</strong> processed by a third-party PCI-DSS-certified processor; we do not store card numbers.</li>
        </ul>

        <h2 style={H2}>3. How We Use Information</h2>
        <ul style={UL}>
          <li>Provide, operate, and improve the Service.</li>
          <li>Authenticate users, enforce access policies, and prevent abuse.</li>
          <li>Bill and collect for usage as set forth in the pricing tier.</li>
          <li>Send service announcements, incident notifications, and security advisories.</li>
          <li>Comply with legal obligations and respond to lawful requests.</li>
        </ul>

        <h2 style={H2}>4. Sharing &amp; Subprocessors</h2>
        <p style={P}>
          We share tenant data only with subprocessors necessary to provide the
          Service (e.g., cloud infrastructure providers, payment processor, email
          delivery). A current list of subprocessors is available on request. We do
          not sell tenant data.
        </p>

        <h2 style={H2}>5. Customer-Managed Encryption</h2>
        <p style={P}>
          Tenants on Pro and Enterprise tiers may bind a customer-managed key
          (BYOK / CMEK) so that ProjexCloud cannot decrypt their data without a
          live grant on the customer&apos;s KMS. See the Security page for details.
        </p>

        <h2 style={H2}>6. Retention</h2>
        <p style={P}>
          Audit ledger entries are retained per their retention class — transient
          (7 days), operational (90 days), or regulated (7 years). Tenant content
          retention follows the tenant&apos;s configuration and the applicable law.
          On account closure, an export window applies before final deletion.
        </p>

        <h2 style={H2}>7. Your Rights</h2>
        <p style={P}>
          Depending on your jurisdiction, you may have the right to access, correct,
          delete, or port your personal data, and to withdraw consent. Tenants can
          exercise these rights via the data-rights endpoints in the tenant-admin
          console; individuals can email <a href="mailto:privacy@projexcloud.com">privacy@projexcloud.com</a>.
        </p>

        <h2 style={H2}>8. International Transfers</h2>
        <p style={P}>
          For tenants in sovereign regions (EU, UK, etc.), data is processed in
          the chosen region and does not cross region boundaries except via an
          explicit data-residency event. Transfers outside the chosen region use
          Standard Contractual Clauses or equivalent safeguards.
        </p>

        <h2 style={H2}>9. Children&apos;s Privacy</h2>
        <p style={P}>
          The Service is not directed to children under 16. We do not knowingly
          collect personal data from children.
        </p>

        <h2 style={H2}>10. Contact</h2>
        <p style={P}>
          Privacy questions: <a href="mailto:privacy@projexcloud.com">privacy@projexcloud.com</a>.
          GDPR/UK GDPR Data Protection Officer: <a href="mailto:dpo@projexcloud.com">dpo@projexcloud.com</a>.
        </p>
      </div>
      <MarketingFooter />
    </div>
  );
}
