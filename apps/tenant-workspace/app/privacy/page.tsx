import { LegalLayout } from '../../components/LegalLayout';

export default function PrivacyPage(): JSX.Element {
  return (
    <LegalLayout docName="Privacy Policy" title="Privacy Policy">
      <h2>1. Overview</h2>
      <p>
        This Privacy Policy explains how ProjexCloud Inc. (&quot;we&quot;, &quot;us&quot;)
        collects, uses, and shares information when you visit projexcloud.com, sign up
        for an account, or use the Service. For tenants subject to GDPR, UK GDPR, or
        DPDP, the Data Processing Agreement supplements this Policy.
      </p>

      <h2>2. Information We Collect</h2>
      <ul>
        <li><strong>Account data:</strong> email, name, company, password hash, MFA factors.</li>
        <li><strong>Tenant data:</strong> content you upload, configure, or process via the Service.</li>
        <li><strong>Usage data:</strong> API call metadata, audit ledger rows, meter events, traces.</li>
        <li><strong>Device data:</strong> IP, user agent, device fingerprint for fraud detection.</li>
        <li><strong>Payment data:</strong> processed by a third-party PCI-DSS-certified processor; we do not store card numbers.</li>
      </ul>

      <h2>3. How We Use Information</h2>
      <ul>
        <li>Provide, operate, and improve the Service.</li>
        <li>Authenticate users, enforce access policies, and prevent abuse.</li>
        <li>Bill and collect for usage as set forth in the pricing tier.</li>
        <li>Send service announcements, incident notifications, and security advisories.</li>
        <li>Comply with legal obligations and respond to lawful requests.</li>
      </ul>

      <h2>4. Sharing &amp; Subprocessors</h2>
      <p>
        We share tenant data only with subprocessors necessary to provide the
        Service (e.g., cloud infrastructure providers, payment processor, email
        delivery). A current list of subprocessors is available on request. We do
        not sell tenant data.
      </p>

      <h2>5. Customer-Managed Encryption</h2>
      <p>
        Tenants on Pro and Enterprise tiers may bind a customer-managed key
        (BYOK / CMEK) so that ProjexCloud cannot decrypt their data without a
        live grant on the customer&apos;s KMS. See the Security page for details.
      </p>

      <h2>6. Retention</h2>
      <p>
        Audit ledger entries are retained per their retention class — transient
        (7 days), operational (90 days), or regulated (7 years). Tenant content
        retention follows the tenant&apos;s configuration and the applicable law.
        On account closure, an export window applies before final deletion.
      </p>

      <h2>7. Your Rights</h2>
      <p>
        Depending on your jurisdiction, you may have the right to access, correct,
        delete, or port your personal data, and to withdraw consent. Tenants can
        exercise these rights via the data-rights endpoints in the tenant-admin
        console; individuals can email <a href="mailto:privacy@projexcloud.com">privacy@projexcloud.com</a>.
      </p>

      <h2>8. International Transfers</h2>
      <p>
        For tenants in sovereign regions (EU, UK, etc.), data is processed in
        the chosen region and does not cross region boundaries except via an
        explicit data-residency event. Transfers outside the chosen region use
        Standard Contractual Clauses or equivalent safeguards.
      </p>

      <h2>9. Children&apos;s Privacy</h2>
      <p>
        The Service is not directed to children under 16. We do not knowingly
        collect personal data from children.
      </p>

      <h2>10. Contact</h2>
      <p>
        Privacy questions: <a href="mailto:privacy@projexcloud.com">privacy@projexcloud.com</a>.
        GDPR/UK GDPR Data Protection Officer: <a href="mailto:dpo@projexcloud.com">dpo@projexcloud.com</a>.
      </p>
    </LegalLayout>
  );
}
