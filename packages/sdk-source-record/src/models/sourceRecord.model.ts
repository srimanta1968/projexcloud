/**
 * sdk-source-record domain model (P16 · EP-374).
 *
 * The vocabulary here mirrors the Postgres ENUM types created in migration 001
 * one-for-one. Keeping the TypeScript unions and the SQL enums in lockstep is what
 * makes an unrecognised value a compile-time error on the way in and a write-time
 * error at the database — there is no third place a bad origin class can hide.
 */

/** WHERE a capture came from. Ordered loosely weakest-to-strongest provenance. */
export const ORIGIN_CLASSES = [
  'USER_PROVIDED',
  'FIRST_PARTY_DIRECT',
  'TENANT_FIRST_PARTY_CRM',
  'USER_AUTHORIZED_CONTACT_STORE',
  'PUBLIC_RECORD',
  'LICENSED_THIRD_PARTY',
  'PARTNER_PROVIDED',
  'UNKNOWN_QUARANTINED',
] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/**
 * Origins that count as FIRST-PARTY evidence — the subject (or the tenant acting
 * on a direct relationship with them) is the source. Promotion to P4_DIRECT
 * requires evidence of one of these; bought or scraped data never qualifies.
 */
export const FIRST_PARTY_ORIGINS: readonly OriginClass[] = [
  'USER_PROVIDED',
  'FIRST_PARTY_DIRECT',
  'TENANT_FIRST_PARTY_CRM',
  'USER_AUTHORIZED_CONTACT_STORE',
];

/** The progressive trust ladder. Index order IS the rung order. */
export const TRUST_STATES = [
  'P0_CAPTURED',
  'P1_NORMALIZED',
  'P2_CANDIDATE',
  'P3_LINKED',
  'P4_DIRECT',
] as const;
export type TrustState = (typeof TRUST_STATES)[number];

export const ASSERTION_STATUSES = ['SURVIVES', 'ASSERTION', 'SUPERSEDED', 'PRIMARY'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

export const EVIDENCE_KINDS = [
  'RAW_PAYLOAD',
  'API_RESPONSE',
  'DOCUMENT',
  'SCREENSHOT',
  'LICENSE_TERMS',
  'CONSENT_RECEIPT',
  'SIGNATURE',
  'OTHER',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * The only legal promotions: exactly one rung at a time, upward. A record cannot
 * skip P2 to reach P3 — each rung has its own evidence requirement, and skipping
 * would mean claiming trust that was never checked.
 */
export const TRUST_TRANSITIONS: Record<TrustState, readonly TrustState[]> = {
  P0_CAPTURED: ['P1_NORMALIZED'],
  P1_NORMALIZED: ['P2_CANDIDATE'],
  P2_CANDIDATE: ['P3_LINKED'],
  P3_LINKED: ['P4_DIRECT'],
  P4_DIRECT: [],
};

/**
 * Per-transition evidence requirements.
 *
 * - P2_CANDIDATE needs normalization to have actually happened (a normalized body).
 * - P3_LINKED needs a subject to link TO — a link with no subject is not a link.
 * - P4_DIRECT needs a first-party evidence reference. This is the rung that says
 *   "the subject themselves told us", and it is the one an incorrect promotion
 *   does the most damage with, so it is the one with the hardest gate.
 */
export interface TransitionRequirement {
  /** Human-readable name of what must be present, used verbatim in the 422 body. */
  requires: string;
  /** Machine-readable reason code returned to the caller. */
  code: string;
}

export const TRANSITION_REQUIREMENTS: Partial<Record<TrustState, TransitionRequirement>> = {
  P2_CANDIDATE: { requires: 'normalized payload', code: 'NORMALIZATION_REQUIRED' },
  P3_LINKED: { requires: 'subject_ref', code: 'SUBJECT_REF_REQUIRED' },
  P4_DIRECT: { requires: 'first-party evidence reference', code: 'FIRST_PARTY_EVIDENCE_REQUIRED' },
};

export interface SourceRecord {
  capture_id: string;
  tenant_id: string;
  source_system: string;
  source_external_id: string | null;
  raw_evidence: Record<string, unknown>;
  fingerprint: string;
  retrieved_at: string;
  origin_class: OriginClass;
  trust_state: TrustState;
  evidence_kind: EvidenceKind;
  evidence_ref: string | null;
  subject_ref: string | null;
  normalized: Record<string, unknown> | null;
  quarantine_reason: string | null;
  promoted_at: string | null;
  normalized_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CaptureInput {
  tenant_id: string;
  source_system: string;
  raw_evidence: Record<string, unknown>;
  /** Content hash of the capture. Omitted -> derived deterministically from the payload. */
  fingerprint?: string;
  source_external_id?: string | null;
  /** Anything not in ORIGIN_CLASSES (including undefined) quarantines the record. */
  origin_class?: string | null;
  evidence_kind?: EvidenceKind;
  evidence_ref?: string | null;
  subject_ref?: string | null;
  retrieved_at?: string;
  metadata?: Record<string, unknown>;
  /** Audit provenance for the capture entry. */
  actor_id?: string;
  purpose?: string;
  causation_id?: string;
}

export interface CaptureResult {
  record: SourceRecord;
  /** false when the fingerprint already existed and the prior capture was returned. */
  created: boolean;
  quarantined: boolean;
}

export interface PromoteInput {
  tenant_id: string;
  capture_id: string;
  to_state: TrustState;
  /** Required for P4_DIRECT — must reference a first-party evidence blob. */
  evidence_ref?: string | null;
  /** Origin class of the evidence being offered, checked against FIRST_PARTY_ORIGINS. */
  evidence_origin_class?: string | null;
  subject_ref?: string | null;
  actor_id?: string;
  purpose?: string;
  causation_id?: string;
  decision_ref?: string;
}

export interface NormalizeInput {
  tenant_id: string;
  capture_id: string;
  actor_id?: string;
  purpose?: string;
  causation_id?: string;
}

/** Contract with sdk-parsing. Injected at boot so this package keeps zero hard deps. */
export interface ContactExtraction {
  fields: Record<string, unknown>;
  confidence?: number;
  extractor?: string;
}
