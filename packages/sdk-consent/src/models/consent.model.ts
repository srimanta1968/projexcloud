/**
 * TypeScript model mirroring consent.* tables per P2-Identity-Access §6.
 */

export type LegalBasis =
  | 'consent'
  | 'contract'
  | 'legitimate-interest'
  | 'vital'
  | 'public-task'
  | 'legal-obligation';

export type ReplayStatus = 'pending' | 'replayed' | 'failed';

/**
 * P10/E3: purpose category. `hipaa_tpo` = HIPAA Treatment/Payment/Operations
 * (+research/marketing); `part2_substance_use` = 42 CFR Part 2 segmented data.
 */
export type PurposeCategory = 'general' | 'hipaa_tpo' | 'part2_substance_use';

export interface PurposeRecord {
  purpose_id: string;
  app_id: string;
  description: string;
  legal_basis: LegalBasis;
  default_jurisdictions: string[];
  created_at: Date;
  /** P10/E3: taxonomy category (default 'general'). */
  category?: PurposeCategory;
  /** P10/E3: true for 42 CFR Part 2 substance-use purposes (segmented consent). */
  segmented?: boolean;
}

export interface ReceiptRecord {
  receipt_id: string;
  person_id: string;
  purpose_id: string;
  processor: string;
  app_id: string;
  jurisdiction: string;
  granted_by_actor: string;
  granted_at: Date;
  expires_at: Date | null;
  source_tenant_id: string | null;
  target_tenant_id: string | null;
  revoked_at: Date | null;
  revocation_id: string | null;
  evidence_hash: Buffer;
}

export interface RevocationRecord {
  revocation_id: string;
  receipt_id: string;
  revoked_by: string;
  reason: string;
  revoked_at: Date;
}

export interface RegisterPurposeInput {
  purpose_id: string;
  app_id: string;
  description: string;
  legal_basis: LegalBasis;
  default_jurisdictions?: string[];
  /** P10/E3: taxonomy category (default 'general'). */
  category?: PurposeCategory;
  /** P10/E3: 42 CFR Part 2 segmented consent (default false). */
  segmented?: boolean;
}

export interface GrantConsentInput {
  person_id: string;
  purpose_id: string;
  processor: string;
  app_id: string;
  jurisdiction: string;
  granted_by_actor: string;
  expires_at?: string;
  source_tenant_id?: string;
  target_tenant_id?: string;
}

export interface RevokeConsentInput {
  revoked_by: string;
  reason: string;
}

export interface CheckConsentInput {
  person_id: string;
  purpose_id: string;
  processor: string;
  jurisdiction: string;
}

export interface CheckConsentResult {
  granted: boolean;
  receipt_id: string | null;
  granted_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}
