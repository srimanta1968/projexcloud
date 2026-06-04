import { LegalLayout } from '../../components/LegalLayout';

export default function DpaPage(): JSX.Element {
  return (
    <LegalLayout docName="Data Processing Agreement" title="Data Processing Agreement">
      <h2>1. Purpose &amp; Scope</h2>
      <p>
        This Data Processing Agreement (&quot;DPA&quot;) supplements the Terms of
        Service for tenants subject to the EU General Data Protection Regulation
        (GDPR), UK GDPR, Switzerland FADP, or India&apos;s DPDP Act. It governs
        ProjexCloud Inc.&apos;s processing of personal data on behalf of the
        tenant (acting as Data Controller).
      </p>

      <h2>2. Definitions</h2>
      <p>
        Terms used in this DPA have the meaning given to them in the GDPR
        (Article 4) or, where applicable, the equivalent provisions of UK GDPR,
        FADP, or DPDP. &quot;Customer Personal Data&quot; means personal data
        processed by ProjexCloud on the tenant&apos;s behalf.
      </p>

      <h2>3. Roles of the Parties</h2>
      <p>
        The tenant is the Data Controller of Customer Personal Data. ProjexCloud
        is the Data Processor and processes Customer Personal Data only on
        documented instructions from the tenant, except where required by law.
      </p>

      <h2>4. Processor Obligations</h2>
      <p>
        ProjexCloud shall: (a) process Customer Personal Data only on the
        tenant&apos;s documented instructions; (b) ensure persons authorized to
        process the data are bound by confidentiality; (c) implement the
        technical and organizational measures set forth in Annex II;
        (d) engage subprocessors only with the tenant&apos;s prior authorization
        as described in Section 6; (e) assist the tenant in responding to
        data-subject requests; (f) notify the tenant of personal data breaches
        without undue delay; (g) make available all information necessary to
        demonstrate compliance.
      </p>

      <h2>5. Customer-Managed Encryption</h2>
      <p>
        Where the tenant has bound a customer-managed key (CMEK) per the
        Security page, ProjexCloud&apos;s technical ability to access Customer
        Personal Data depends on the active grant on the tenant&apos;s KMS.
        Revoking the grant renders the data undecryptable within
        approximately 30 seconds.
      </p>

      <h2>6. Subprocessors</h2>
      <p>
        The current list of subprocessors is available on request and via the
        tenant-admin console. ProjexCloud will provide at least 30 days&apos;
        notice before engaging a new subprocessor, during which the tenant may
        object on reasonable grounds.
      </p>

      <h2>7. International Transfers</h2>
      <p>
        For Customer Personal Data subject to the GDPR or UK GDPR, transfers
        outside the EEA or UK rely on the EU Standard Contractual Clauses
        (Module 2 / Module 3 as applicable) or the UK International Data Transfer
        Agreement / Addendum, supplemented by the technical measures in Annex II.
      </p>

      <h2>8. Data Subject Rights</h2>
      <p>
        ProjexCloud provides tenant-admin endpoints under
        <code> /api/data-rights/* </code> for tenants to action data-subject
        access, rectification, erasure, restriction, portability, and objection
        requests. Where a data subject contacts ProjexCloud directly,
        ProjexCloud will redirect them to the tenant.
      </p>

      <h2>9. Audit &amp; Inspection</h2>
      <p>
        ProjexCloud makes the SOC 2 Type II report (once available), penetration
        test summaries, and the live audit chain export available under NDA upon
        request. Annual on-site audits are available for Enterprise tenants on
        reasonable notice.
      </p>

      <h2>10. Annex I — Description of Processing</h2>
      <p>[DRAFT — categories of data subjects, categories of personal data, types of processing, duration.]</p>

      <h2>11. Annex II — Technical &amp; Organizational Measures</h2>
      <p>[DRAFT — encryption at rest and in transit, access control, audit logging, vulnerability management, incident response, BCP/DR. Reference the Security page.]</p>

      <h2>12. Annex III — Subprocessors</h2>
      <p>[DRAFT — current list to be exported from the subprocessor registry.]</p>

      <p className="!mt-8 italic text-muted-foreground">
        To execute a counter-signed copy of this DPA, contact{' '}
        <a href="mailto:legal@projexcloud.com">legal@projexcloud.com</a>.
      </p>
    </LegalLayout>
  );
}
