import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { ORIGIN_CLASSES, type EvidenceKind, type OriginClass } from '../models/sourceRecord.model';

/**
 * sdk-source-record source-rights attestation (P16 · EP-374 · PCF-01-4).
 *
 * The signed answer to two questions an auditor will eventually ask: were we
 * allowed to hold this data, and what were we allowed to do with it?
 *
 * Three properties do the work:
 *
 *   1. PAPERWORK IS MANDATORY FOR BOUGHT DATA. LICENSED_THIRD_PARTY and
 *      PARTNER_PROVIDED origins cannot be attested without an evidence blob
 *      reference. The service refuses, and the migration-001 CHECK refuses too,
 *      so the rule survives a direct SQL writer.
 *   2. THE SIGNATURE COVERS THE TERMS, NOT JUST THE ROW. It is computed over the
 *      source fingerprint, mapping version and the permitted-use set — so a later
 *      claim of broader permissions cannot be dressed up as the original grant.
 *   3. PERMITTED USE FAILS CLOSED. checkPermittedUse refuses a purpose when there
 *      is no attestation, when the attestation does not list the purpose, and when
 *      the collection period has lapsed. Absence of evidence is never read as
 *      permission.
 *
 * Immutability is the database's job (trigger on UPDATE and DELETE): an
 * attestation whose terms could be edited after signing would be worthless.
 */

const SOURCE_RECORD_AUDIT_POOL = process.env.SOURCE_RECORD_AUDIT_POOL || 'admin-default';

const ATTESTATION_COLS = `
  attestation_id, tenant_id, capture_id, source_fingerprint, attestor_principal,
  origin_class, permitted_uses, jurisdiction, license_ref, collection_period_start,
  collection_period_end, evidence_blob_ref, evidence_kind, mapping_version, signature,
  signature_alg, signed_at, metadata, created_at`;

/** Origins whose data was obtained from someone else and needs its paperwork. */
const PAPERWORK_REQUIRED_ORIGINS: readonly OriginClass[] = [
  'LICENSED_THIRD_PARTY',
  'PARTNER_PROVIDED',
];

export interface SourceRightsAttestation {
  attestation_id: string;
  tenant_id: string;
  capture_id: string | null;
  source_fingerprint: string;
  attestor_principal: string;
  origin_class: OriginClass;
  permitted_uses: string[];
  jurisdiction: string | null;
  license_ref: string | null;
  collection_period_start: string | null;
  collection_period_end: string | null;
  evidence_blob_ref: string | null;
  evidence_kind: EvidenceKind;
  mapping_version: string | null;
  signature: string;
  signature_alg: string;
  signed_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SignAttestationInput {
  tenant_id: string;
  /** The platform principal doing the attesting — recorded and signed over. */
  attestor_principal: string;
  origin_class: OriginClass;
  permitted_uses: string[];
  /** Either the capture being attested, or a bare fingerprint for an external one. */
  capture_id?: string | null;
  source_fingerprint?: string;
  jurisdiction?: string | null;
  license_ref?: string | null;
  collection_period_start?: string | null;
  collection_period_end?: string | null;
  /** Existing sdk-evidence blob id. Mutually exclusive with evidence_payload. */
  evidence_blob_ref?: string | null;
  /** Raw evidence to capture through sdk-evidence before signing. */
  evidence_payload?: Record<string, unknown> | null;
  evidence_kind?: EvidenceKind;
  mapping_version?: string | null;
  metadata?: Record<string, unknown>;
  purpose?: string;
  causation_id?: string;
}

/** Raised when required rights paperwork is absent. Names what is missing. */
export class AttestationEvidenceMissing extends Error {
  readonly status = 422;
  readonly code = 'ATTESTATION_EVIDENCE_REQUIRED';
  constructor(public origin_class: OriginClass, public missing_evidence: string) {
    super(
      `[sdk-source-record] origin_class ${origin_class} requires ${missing_evidence} before it can be attested`,
    );
    this.name = 'AttestationEvidenceMissing';
  }
}

export class AttestationNotFound extends Error {
  readonly status = 404;
  readonly code = 'ATTESTATION_NOT_FOUND';
  constructor(public attestation_id: string) {
    super(`[sdk-source-record] attestation ${attestation_id} not found for tenant`);
    this.name = 'AttestationNotFound';
  }
}

export class CaptureFingerprintUnknown extends Error {
  readonly status = 422;
  readonly code = 'SOURCE_FINGERPRINT_REQUIRED';
  constructor() {
    super(
      '[sdk-source-record] an attestation needs either a capture_id to read the fingerprint from, or an explicit source_fingerprint',
    );
    this.name = 'CaptureFingerprintUnknown';
  }
}

/* --------------------------------------------------------------- hooks */

/** sdk-evidence bridge: persist the rights paperwork and return its blob id. */
export type EvidenceCapturer = (
  payload: Record<string, unknown>,
  ctx: { tenant_id: string; source_fingerprint: string; evidence_kind: EvidenceKind },
) => Promise<string | null>;

let evidenceCapturer: EvidenceCapturer | null = null;

/**
 * Wire sdk-evidence POST /api/evidence/capture at app boot.
 *
 * There is deliberately NO default implementation. A stub that returned a fake
 * blob id would let bought data be attested with paperwork that does not exist —
 * exactly the failure this service is built to prevent. With no capturer wired,
 * a caller must supply an evidence_blob_ref that already exists.
 */
export function setEvidenceCapturer(fn: EvidenceCapturer | null): void {
  evidenceCapturer = fn;
}

export type AttestationSigner = (
  canonical: string,
  ctx: { tenant_id: string; attestor_principal: string },
) => Promise<{ signature: string; alg: string }>;

const INSECURE_DEFAULT_MARKERS = ['do-not-use-in-prod', 'change-me'];
const DEV_SIGNING_KEY = Buffer.alloc(32, 13);

function signingKey(): Buffer {
  const raw = process.env.SOURCE_RECORD_ATTESTATION_KEY || '';
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SOURCE_RECORD_ATTESTATION_KEY not set — refusing to sign rights attestations with no key material',
      );
    }
    return DEV_SIGNING_KEY;
  }
  for (const marker of INSECURE_DEFAULT_MARKERS) {
    if (raw.includes(marker)) {
      throw new Error(
        `SOURCE_RECORD_ATTESTATION_KEY contains insecure-default marker "${marker}" — refusing to start`,
      );
    }
  }
  return Buffer.from(raw, 'utf-8');
}

/** HMAC-SHA256 under a per-principal HKDF subkey. Production swaps in sdk-vault. */
const localSigner: AttestationSigner = async (canonical, ctx) => {
  const key = crypto.hkdfSync(
    'sha256',
    signingKey(),
    Buffer.from(`${ctx.tenant_id}:${ctx.attestor_principal}`, 'utf-8'),
    Buffer.from('sdk-source-record/attestation/v1', 'utf-8'),
    32,
  );
  return {
    signature: crypto.createHmac('sha256', Buffer.from(key)).update(canonical).digest('base64'),
    alg: 'HMAC-SHA256',
  };
};

let attestationSigner: AttestationSigner = localSigner;

export function setAttestationSigner(fn: AttestationSigner | null): void {
  attestationSigner = fn ?? localSigner;
}

/**
 * The exact bytes the signature covers. permitted_uses is sorted and deduped so
 * the same grant always produces the same signature regardless of argument order,
 * and every field that could change the MEANING of the grant is inside it.
 */
export function canonicalAttestationPayload(parts: {
  tenant_id: string;
  attestor_principal: string;
  source_fingerprint: string;
  origin_class: OriginClass;
  mapping_version: string | null;
  permitted_uses: string[];
  jurisdiction: string | null;
  license_ref: string | null;
  collection_period_start: string | null;
  collection_period_end: string | null;
  evidence_blob_ref: string | null;
}): string {
  return JSON.stringify({
    v: 1,
    tenant_id: parts.tenant_id,
    attestor_principal: parts.attestor_principal,
    source_fingerprint: parts.source_fingerprint,
    origin_class: parts.origin_class,
    mapping_version: parts.mapping_version,
    permitted_uses: normalizeUses(parts.permitted_uses),
    jurisdiction: parts.jurisdiction,
    license_ref: parts.license_ref,
    collection_period_start: parts.collection_period_start,
    collection_period_end: parts.collection_period_end,
    evidence_blob_ref: parts.evidence_blob_ref,
  });
}

function normalizeUses(uses: string[]): string[] {
  return Array.from(
    new Set((uses ?? []).map((u) => String(u).trim().toLowerCase()).filter((u) => u.length > 0)),
  ).sort();
}

function isOriginClass(value: unknown): value is OriginClass {
  return typeof value === 'string' && (ORIGIN_CLASSES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------- sign */

/**
 * Sign and store a source-rights attestation.
 *
 * Evidence resolution order: an explicit blob ref is used as-is; otherwise a raw
 * payload is captured through sdk-evidence when a capturer is wired. If neither
 * yields a reference and the origin needs paperwork, the attestation is refused
 * BEFORE anything is written — a half-signed attestation is not a thing.
 *
 * @throws AttestationEvidenceMissing bought/partner data with no evidence blob
 * @throws CaptureFingerprintUnknown  nothing to bind the signature to
 */
export async function signAttestation(
  input: SignAttestationInput,
): Promise<SourceRightsAttestation> {
  if (!isOriginClass(input.origin_class)) {
    throw new Error(
      `[sdk-source-record] origin_class '${String(input.origin_class)}' is not a recognised provenance class`,
    );
  }

  let source_fingerprint = input.source_fingerprint ?? null;
  if (!source_fingerprint && input.capture_id) {
    const capture = await dataService.one<{ fingerprint: string }>(
      `SELECT fingerprint FROM source_record.source_record
        WHERE tenant_id = $1 AND capture_id = $2`,
      [input.tenant_id, input.capture_id],
    );
    source_fingerprint = capture?.fingerprint ?? null;
  }
  if (!source_fingerprint) throw new CaptureFingerprintUnknown();

  const evidence_kind: EvidenceKind = input.evidence_kind ?? 'DOCUMENT';
  let evidence_blob_ref = input.evidence_blob_ref?.trim() || null;
  if (!evidence_blob_ref && input.evidence_payload && evidenceCapturer) {
    evidence_blob_ref =
      (await evidenceCapturer(input.evidence_payload, {
        tenant_id: input.tenant_id,
        source_fingerprint,
        evidence_kind,
      })) || null;
  }

  if (PAPERWORK_REQUIRED_ORIGINS.includes(input.origin_class) && !evidence_blob_ref) {
    throw new AttestationEvidenceMissing(
      input.origin_class,
      'an evidence blob reference (licence, contract or data-sharing agreement)',
    );
  }

  const permitted_uses = normalizeUses(input.permitted_uses);
  const canonical = canonicalAttestationPayload({
    tenant_id: input.tenant_id,
    attestor_principal: input.attestor_principal,
    source_fingerprint,
    origin_class: input.origin_class,
    mapping_version: input.mapping_version ?? null,
    permitted_uses,
    jurisdiction: input.jurisdiction ?? null,
    license_ref: input.license_ref ?? null,
    collection_period_start: input.collection_period_start ?? null,
    collection_period_end: input.collection_period_end ?? null,
    evidence_blob_ref,
  });
  const signed = await attestationSigner(canonical, {
    tenant_id: input.tenant_id,
    attestor_principal: input.attestor_principal,
  });

  const row = await dataService.one<SourceRightsAttestation>(
    `INSERT INTO source_record.source_rights_attestation
       (tenant_id, capture_id, source_fingerprint, attestor_principal, origin_class,
        permitted_uses, jurisdiction, license_ref, collection_period_start,
        collection_period_end, evidence_blob_ref, evidence_kind, mapping_version,
        signature, signature_alg, metadata)
     VALUES ($1, $2, $3, $4, $5::source_record.origin_class, $6::text[], $7, $8,
             $9::timestamptz, $10::timestamptz, $11, $12::source_record.evidence_kind,
             $13, $14, $15, $16::jsonb)
     RETURNING ${ATTESTATION_COLS}`,
    [
      input.tenant_id,
      input.capture_id ?? null,
      source_fingerprint,
      input.attestor_principal,
      input.origin_class,
      permitted_uses,
      input.jurisdiction ?? null,
      input.license_ref ?? null,
      input.collection_period_start ?? null,
      input.collection_period_end ?? null,
      evidence_blob_ref,
      evidence_kind,
      input.mapping_version ?? null,
      signed.signature,
      signed.alg,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!row) throw new Error('[sdk-source-record] attestation insert returned no row');

  await emitEvent({
    event_type: 'source-record.attestation.signed.v1',
    pool_index: SOURCE_RECORD_AUDIT_POOL,
    actor_kind: 'human',
    actor_id: input.attestor_principal,
    tenant_id: input.tenant_id,
    subject_kind: 'source_record.source_rights_attestation',
    subject_id: row.attestation_id,
    payload: {
      attestation_id: row.attestation_id,
      capture_id: row.capture_id,
      source_fingerprint: row.source_fingerprint,
      origin_class: row.origin_class,
      permitted_uses: row.permitted_uses,
      jurisdiction: row.jurisdiction,
      license_ref: row.license_ref,
      evidence_blob_ref: row.evidence_blob_ref,
      mapping_version: row.mapping_version,
      signature_alg: row.signature_alg,
      purpose: input.purpose ?? null,
      causation_id: input.causation_id ?? null,
    },
  });

  return row;
}

/** Recompute the signature over the stored terms and compare, timing-safely. */
export async function verifyAttestation(
  tenant_id: string,
  attestation_id: string,
): Promise<{ valid: boolean; attestation: SourceRightsAttestation }> {
  const attestation = await getAttestation(tenant_id, attestation_id);
  const canonical = canonicalAttestationPayload({
    tenant_id: attestation.tenant_id,
    attestor_principal: attestation.attestor_principal,
    source_fingerprint: attestation.source_fingerprint,
    origin_class: attestation.origin_class,
    mapping_version: attestation.mapping_version,
    permitted_uses: attestation.permitted_uses,
    jurisdiction: attestation.jurisdiction,
    license_ref: attestation.license_ref,
    collection_period_start: attestation.collection_period_start,
    collection_period_end: attestation.collection_period_end,
    evidence_blob_ref: attestation.evidence_blob_ref,
  });
  const recomputed = await attestationSigner(canonical, {
    tenant_id: attestation.tenant_id,
    attestor_principal: attestation.attestor_principal,
  });
  const a = Buffer.from(recomputed.signature);
  const b = Buffer.from(attestation.signature);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { valid, attestation };
}

export async function getAttestation(
  tenant_id: string,
  attestation_id: string,
): Promise<SourceRightsAttestation> {
  const row = await dataService.one<SourceRightsAttestation>(
    `SELECT ${ATTESTATION_COLS} FROM source_record.source_rights_attestation
      WHERE tenant_id = $1 AND attestation_id = $2`,
    [tenant_id, attestation_id],
  );
  if (!row) throw new AttestationNotFound(attestation_id);
  return row;
}

/* ------------------------------------------------------ permitted use */

export interface PermittedUseQuery {
  tenant_id: string;
  purpose: string;
  /** Check the rights covering a linked subject. */
  subject_ref?: string;
  /** Or check one specific capture / fingerprint directly. */
  capture_id?: string;
  source_fingerprint?: string;
  /** Instant the use would occur. Defaults to now. */
  at?: string;
}

export interface PermittedUseVerdict {
  permitted: boolean;
  /** Machine-readable refusal reason; null when permitted. */
  reason:
    | null
    | 'NO_ATTESTATION'
    | 'PURPOSE_NOT_ATTESTED'
    | 'COLLECTION_PERIOD_LAPSED';
  /** The attestation that granted the use, when permitted. */
  attestation_id: string | null;
  /** Everything the covering attestations DO allow — the caller's next best option. */
  permitted_uses: string[];
}

/**
 * Can this purpose be served by this data?
 *
 * FAILS CLOSED at every step. No attestation, a purpose outside the attested set,
 * or a lapsed collection period all return permitted:false with the reason named.
 * This is the mechanism that keeps a licensed record out of an incompatible use:
 * a consumer that asks and honours the answer cannot repurpose data by accident.
 *
 * A subject linked to several captures may be covered by several attestations —
 * ANY of them granting the purpose is enough, since each covers its own source.
 */
export async function checkPermittedUse(query: PermittedUseQuery): Promise<PermittedUseVerdict> {
  const purpose = String(query.purpose ?? '').trim().toLowerCase();
  if (!purpose) {
    return { permitted: false, reason: 'PURPOSE_NOT_ATTESTED', attestation_id: null, permitted_uses: [] };
  }

  const rows = await dataService.rows<SourceRightsAttestation>(
    `SELECT ${ATTESTATION_COLS} FROM source_record.source_rights_attestation a
      WHERE a.tenant_id = $1
        AND (
          ($2::text IS NULL AND $3::uuid IS NULL AND $4::text IS NULL)
          OR ($3::uuid IS NOT NULL AND a.capture_id = $3::uuid)
          OR ($4::text IS NOT NULL AND a.source_fingerprint = $4)
          OR ($2::text IS NOT NULL AND a.capture_id IN (
                SELECT capture_id FROM source_record.source_record
                 WHERE tenant_id = $1 AND subject_ref = $2))
        )
      ORDER BY signed_at DESC`,
    [
      query.tenant_id,
      query.subject_ref ?? null,
      query.capture_id ?? null,
      query.source_fingerprint ?? null,
    ],
  );

  if (rows.length === 0) {
    return { permitted: false, reason: 'NO_ATTESTATION', attestation_id: null, permitted_uses: [] };
  }

  const at = query.at ? new Date(query.at) : new Date();
  const allUses = new Set<string>();
  let sawPurposeButLapsed = false;

  for (const row of rows) {
    for (const u of row.permitted_uses ?? []) allUses.add(u);
    if (!(row.permitted_uses ?? []).includes(purpose)) continue;

    const start = row.collection_period_start ? new Date(row.collection_period_start) : null;
    const end = row.collection_period_end ? new Date(row.collection_period_end) : null;
    // An open-ended period is a grant with no expiry; a closed one stops meaning
    // anything the moment it ends.
    if ((start && at < start) || (end && at > end)) {
      sawPurposeButLapsed = true;
      continue;
    }
    return {
      permitted: true,
      reason: null,
      attestation_id: row.attestation_id,
      permitted_uses: Array.from(allUses).sort(),
    };
  }

  return {
    permitted: false,
    reason: sawPurposeButLapsed ? 'COLLECTION_PERIOD_LAPSED' : 'PURPOSE_NOT_ATTESTED',
    attestation_id: null,
    permitted_uses: Array.from(allUses).sort(),
  };
}

export async function listAttestations(filter: {
  tenant_id: string;
  capture_id?: string;
  origin_class?: OriginClass;
  limit?: number;
  offset?: number;
}): Promise<SourceRightsAttestation[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<SourceRightsAttestation>(
    `SELECT ${ATTESTATION_COLS} FROM source_record.source_rights_attestation
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR capture_id = $2::uuid)
        AND ($3::source_record.origin_class IS NULL OR origin_class = $3::source_record.origin_class)
      ORDER BY signed_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.capture_id ?? null, filter.origin_class ?? null],
  );
}
