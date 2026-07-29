import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  ORIGIN_CLASSES,
  type AssertionStatus,
  type OriginClass,
} from '../models/sourceRecord.model';

/**
 * sdk-source-record bitemporal assertions (P16 · EP-374 · PCF-01-3).
 *
 * An assertion is a CLAIM, not a fact: "per this origin, at this effective
 * period, the subject's <attribute> was <value>; we retrieved it at <retrieved_at>".
 * Two conflicting claims from different origins are the normal case, not an error
 * to be resolved here — resolving which value to DISPLAY is sdk-projection's job.
 *
 * The one invariant this service exists to protect: NO CODE PATH REWRITES OR
 * DELETES A CLAIM. Superseding stamps status + superseded_by on the prior row and
 * inserts the successor beside it. The database enforces the same rule with a
 * trigger (migration 001), so this is belt and braces rather than a convention.
 *
 * PII values are envelope-encrypted before persistence through an injectable
 * cipher (sdk-vault at gateway boot); the default is a local AES-256-GCM envelope
 * with an HKDF-derived per-tenant key so a dev deployment still never stores a raw
 * identifier in a column.
 */

const SOURCE_RECORD_AUDIT_POOL = process.env.SOURCE_RECORD_AUDIT_POOL || 'admin-default';

const ASSERTION_COLS = `
  assertion_id, tenant_id, capture_id, subject_ref, attribute, value, value_encrypted,
  vault_key_ref, origin_class, confidence, effective_from, effective_to, retrieved_at,
  status, evidence_ref, superseded_by, superseded_at, metadata, created_at`;

export interface SourceAssertion {
  assertion_id: string;
  tenant_id: string;
  capture_id: string | null;
  subject_ref: string;
  attribute: string;
  value: string | null;
  value_encrypted: boolean;
  vault_key_ref: string | null;
  origin_class: OriginClass;
  confidence: string | number;
  effective_from: string;
  effective_to: string | null;
  retrieved_at: string;
  status: AssertionStatus;
  evidence_ref: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface WriteAssertionInput {
  tenant_id: string;
  subject_ref: string;
  attribute: string;
  value: string;
  origin_class: OriginClass;
  capture_id?: string | null;
  confidence?: number;
  effective_from?: string;
  effective_to?: string | null;
  retrieved_at?: string;
  status?: AssertionStatus;
  evidence_ref?: string | null;
  /** Explicit PII declaration. Wins over the classifier when provided. */
  is_pii?: boolean;
  metadata?: Record<string, unknown>;
  actor_id?: string;
  purpose?: string;
  causation_id?: string;
}

export interface SupersedeAssertionInput {
  tenant_id: string;
  /** The assertion being replaced. Its row is stamped, never rewritten. */
  assertion_id: string;
  /** The replacement claim. Written as a new row beside the old one. */
  replacement: Omit<WriteAssertionInput, 'tenant_id' | 'subject_ref' | 'attribute'> & {
    subject_ref?: string;
    attribute?: string;
  };
  reason?: string;
  actor_id?: string;
  purpose?: string;
  causation_id?: string;
}

/** Raised when an assertion does not exist for the tenant. */
export class AssertionNotFound extends Error {
  readonly status = 404;
  readonly code = 'ASSERTION_NOT_FOUND';
  constructor(public assertion_id: string) {
    super(`[sdk-source-record] assertion ${assertion_id} not found for tenant`);
    this.name = 'AssertionNotFound';
  }
}

/** Raised when the prior claim has already been replaced. Supersede is one-way. */
export class AssertionAlreadySuperseded extends Error {
  readonly status = 409;
  readonly code = 'ASSERTION_ALREADY_SUPERSEDED';
  constructor(public assertion_id: string, public superseded_by: string) {
    super(
      `[sdk-source-record] assertion ${assertion_id} was already superseded by ${superseded_by}`,
    );
    this.name = 'AssertionAlreadySuperseded';
  }
}

/* --------------------------------------------------------- PII envelope */

export interface EnvelopeCipher {
  encrypt(plaintext: string, ctx: { tenant_id: string; attribute: string }): Promise<{
    ciphertext: string;
    key_ref: string;
  }>;
  decrypt(
    ciphertext: string,
    ctx: { tenant_id: string; attribute: string; key_ref: string | null },
  ): Promise<string>;
}

const INSECURE_DEFAULT_MARKERS = ['do-not-use-in-prod', 'change-me'];
/** Dev-only key material, mirroring sdk-notification's DEV_DESTINATION_MASTER_KEY. */
const DEV_MASTER_KEY = Buffer.alloc(32, 11);

function masterKey(): Buffer {
  const raw = process.env.SOURCE_RECORD_MASTER_KEY || '';
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SOURCE_RECORD_MASTER_KEY not set — refusing to envelope PII assertion values with no key material',
      );
    }
    return DEV_MASTER_KEY;
  }
  for (const marker of INSECURE_DEFAULT_MARKERS) {
    if (raw.includes(marker)) {
      throw new Error(
        `SOURCE_RECORD_MASTER_KEY contains insecure-default marker "${marker}" — refusing to start`,
      );
    }
  }
  return Buffer.from(raw, 'utf-8');
}

/**
 * Local AES-256-GCM envelope with a per-tenant HKDF subkey. Leaking one tenant's
 * derived key does not expose siblings. Production wires sdk-vault's
 * POST /api/vault/encrypt over setEnvelopeCipher and this path stops being used.
 */
const localCipher: EnvelopeCipher = {
  async encrypt(plaintext, ctx) {
    const key = crypto.hkdfSync(
      'sha256',
      masterKey(),
      Buffer.from(ctx.tenant_id, 'utf-8'),
      Buffer.from('sdk-source-record/assertion/v1', 'utf-8'),
      32,
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`,
      key_ref: 'local:hkdf/sdk-source-record/assertion/v1',
    };
  },
  async decrypt(ciphertext, ctx) {
    const [version, ivB64, tagB64, dataB64] = ciphertext.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('[sdk-source-record] unrecognised assertion value envelope');
    }
    const key = crypto.hkdfSync(
      'sha256',
      masterKey(),
      Buffer.from(ctx.tenant_id, 'utf-8'),
      Buffer.from('sdk-source-record/assertion/v1', 'utf-8'),
      32,
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
  },
};

let envelopeCipher: EnvelopeCipher = localCipher;

/** Wire sdk-vault's envelope encryption at app boot. */
export function setEnvelopeCipher(cipher: EnvelopeCipher | null): void {
  envelopeCipher = cipher ?? localCipher;
}

export type PiiClassifier = (attribute: string) => boolean;

/**
 * Direct identifiers — the attributes that name or reach a specific person. These
 * are data-protection primitives, not domain vocabulary, so the list stays
 * vertical-neutral. Override with setPiiClassifier for a stricter policy.
 */
const DIRECT_IDENTIFIER_ATTRIBUTES = new Set([
  'email',
  'email_address',
  'phone',
  'phone_number',
  'mobile',
  'address',
  'street_address',
  'postal_address',
  'national_id',
  'tax_id',
  'date_of_birth',
  'full_name',
  'given_name',
  'family_name',
]);

const defaultPiiClassifier: PiiClassifier = (attribute) =>
  DIRECT_IDENTIFIER_ATTRIBUTES.has(attribute.trim().toLowerCase());

let piiClassifier: PiiClassifier = defaultPiiClassifier;

export function setPiiClassifier(fn: PiiClassifier | null): void {
  piiClassifier = fn ?? defaultPiiClassifier;
}

/* ------------------------------------------------------- survivorship order */

/**
 * Ordering hint only. A claim made by the subject themselves outranks one bought
 * from a third-party data supplier, all else equal — but this SDK deliberately
 * does NOT decide the display value. sdk-projection applies the tenant's
 * survivorship rules; this ranking just puts the most defensible claim first for a
 * human reading the list.
 */
const ORIGIN_TRUST_RANK: Record<OriginClass, number> = {
  USER_PROVIDED: 70,
  FIRST_PARTY_DIRECT: 60,
  TENANT_FIRST_PARTY_CRM: 50,
  USER_AUTHORIZED_CONTACT_STORE: 40,
  PARTNER_PROVIDED: 30,
  LICENSED_THIRD_PARTY: 20,
  PUBLIC_RECORD: 10,
  UNKNOWN_QUARANTINED: 0,
};

const STATUS_RANK: Record<AssertionStatus, number> = {
  PRIMARY: 3,
  SURVIVES: 2,
  ASSERTION: 1,
  SUPERSEDED: 0,
};

function survivorshipSort(a: SourceAssertion, b: SourceAssertion): number {
  const byStatus = STATUS_RANK[b.status] - STATUS_RANK[a.status];
  if (byStatus !== 0) return byStatus;
  const byOrigin = ORIGIN_TRUST_RANK[b.origin_class] - ORIGIN_TRUST_RANK[a.origin_class];
  if (byOrigin !== 0) return byOrigin;
  const byConfidence = Number(b.confidence) - Number(a.confidence);
  if (byConfidence !== 0) return byConfidence;
  return new Date(b.retrieved_at).getTime() - new Date(a.retrieved_at).getTime();
}

/* -------------------------------------------------------------- write */

function isOriginClass(value: unknown): value is OriginClass {
  return typeof value === 'string' && (ORIGIN_CLASSES as readonly string[]).includes(value);
}

/**
 * Write one bitemporal claim.
 *
 * effective_from/effective_to say when the fact held in the world; retrieved_at
 * says when we learned it. Keeping them separate is what lets a late-arriving
 * source correct history without pretending we knew earlier than we did.
 *
 * A PII value is enveloped before it reaches the INSERT, so the plaintext never
 * touches the column, the query log or a replica.
 */
export async function writeAssertion(input: WriteAssertionInput): Promise<SourceAssertion> {
  if (!isOriginClass(input.origin_class)) {
    throw new Error(
      `[sdk-source-record] origin_class '${String(input.origin_class)}' is not a recognised provenance class`,
    );
  }

  const isPii = input.is_pii ?? piiClassifier(input.attribute);
  let value = input.value;
  let vault_key_ref: string | null = null;
  if (isPii && value != null) {
    const enveloped = await envelopeCipher.encrypt(value, {
      tenant_id: input.tenant_id,
      attribute: input.attribute,
    });
    value = enveloped.ciphertext;
    vault_key_ref = enveloped.key_ref;
  }

  const row = await dataService.one<SourceAssertion>(
    `INSERT INTO source_record.source_assertion
       (tenant_id, capture_id, subject_ref, attribute, value, value_encrypted, vault_key_ref,
        origin_class, confidence, effective_from, effective_to, retrieved_at, status,
        evidence_ref, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::source_record.origin_class,
             COALESCE($9::numeric, 1.0), COALESCE($10::timestamptz, now()), $11::timestamptz,
             COALESCE($12::timestamptz, now()), COALESCE($13::source_record.assertion_status, 'ASSERTION'),
             $14, $15::jsonb)
     RETURNING ${ASSERTION_COLS}`,
    [
      input.tenant_id,
      input.capture_id ?? null,
      input.subject_ref,
      input.attribute,
      value,
      isPii,
      vault_key_ref,
      input.origin_class,
      input.confidence ?? null,
      input.effective_from ?? null,
      input.effective_to ?? null,
      input.retrieved_at ?? null,
      input.status ?? null,
      input.evidence_ref ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!row) throw new Error('[sdk-source-record] assertion insert returned no row');

  await emitAssertionWritten(row, {
    actor_id: input.actor_id,
    purpose: input.purpose,
    causation_id: input.causation_id,
  });

  return row;
}

/** One written entry per claim, whoever wrote it and however it arrived. */
async function emitAssertionWritten(
  row: SourceAssertion,
  ctx: { actor_id?: string; purpose?: string; causation_id?: string },
): Promise<void> {
  await emitEvent({
    event_type: 'source-record.assertion.written.v1',
    pool_index: SOURCE_RECORD_AUDIT_POOL,
    actor_kind: ctx.actor_id ? 'human' : 'service',
    actor_id: ctx.actor_id || 'sdk-source-record',
    tenant_id: row.tenant_id,
    subject_kind: 'source_record.source_assertion',
    subject_id: row.assertion_id,
    payload: {
      assertion_id: row.assertion_id,
      capture_id: row.capture_id,
      subject_ref: row.subject_ref,
      attribute: row.attribute,
      // The VALUE never enters the audit payload — the ledger is replayable by
      // people who are not cleared to read the identifier itself.
      value_encrypted: row.value_encrypted,
      origin_class: row.origin_class,
      confidence: Number(row.confidence),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      retrieved_at: row.retrieved_at,
      status: row.status,
      purpose: ctx.purpose ?? null,
      causation_id: ctx.causation_id ?? null,
    },
  });
}

/* --------------------------------------------------------- supersede */

/**
 * Replace a claim WITHOUT destroying it.
 *
 * Both writes happen in one transaction: the successor is inserted, then the prior
 * row is stamped SUPERSEDED with superseded_by pointing at it. The stamp UPDATE
 * touches only status/superseded_by/superseded_at — the immutability trigger
 * rejects anything else, and rejects the stamp entirely if the row was already
 * superseded, so a concurrent double-supersede cannot fork the chain.
 *
 * @throws AssertionNotFound          the prior claim does not exist for the tenant
 * @throws AssertionAlreadySuperseded the prior claim already names a successor
 */
export async function supersedeAssertion(input: SupersedeAssertionInput): Promise<{
  prior: SourceAssertion;
  replacement: SourceAssertion;
}> {
  const prior = await dataService.one<SourceAssertion>(
    `SELECT ${ASSERTION_COLS} FROM source_record.source_assertion
      WHERE tenant_id = $1 AND assertion_id = $2`,
    [input.tenant_id, input.assertion_id],
  );
  if (!prior) throw new AssertionNotFound(input.assertion_id);
  if (prior.superseded_by) {
    throw new AssertionAlreadySuperseded(prior.assertion_id, prior.superseded_by);
  }

  const spec = input.replacement;
  const subject_ref = spec.subject_ref ?? prior.subject_ref;
  const attribute = spec.attribute ?? prior.attribute;
  const origin_class = spec.origin_class ?? prior.origin_class;
  if (!isOriginClass(origin_class)) {
    throw new Error(
      `[sdk-source-record] origin_class '${String(origin_class)}' is not a recognised provenance class`,
    );
  }

  const isPii = spec.is_pii ?? piiClassifier(attribute);
  let value = spec.value;
  let vault_key_ref: string | null = null;
  if (isPii && value != null) {
    const enveloped = await envelopeCipher.encrypt(value, {
      tenant_id: input.tenant_id,
      attribute,
    });
    value = enveloped.ciphertext;
    vault_key_ref = enveloped.key_ref;
  }

  const { replacement, stamped } = await dataService.tx(async (q) => {
    const ins = await q<SourceAssertion>(
      `INSERT INTO source_record.source_assertion
         (tenant_id, capture_id, subject_ref, attribute, value, value_encrypted, vault_key_ref,
          origin_class, confidence, effective_from, effective_to, retrieved_at, status,
          evidence_ref, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::source_record.origin_class,
               COALESCE($9::numeric, 1.0), COALESCE($10::timestamptz, now()), $11::timestamptz,
               COALESCE($12::timestamptz, now()), COALESCE($13::source_record.assertion_status, 'ASSERTION'),
               $14, $15::jsonb)
       RETURNING ${ASSERTION_COLS}`,
      [
        input.tenant_id,
        spec.capture_id ?? prior.capture_id,
        subject_ref,
        attribute,
        value,
        isPii,
        vault_key_ref,
        origin_class,
        spec.confidence ?? null,
        spec.effective_from ?? null,
        spec.effective_to ?? null,
        spec.retrieved_at ?? null,
        spec.status ?? null,
        spec.evidence_ref ?? null,
        JSON.stringify(spec.metadata ?? {}),
      ],
    );
    const next = ins.rows[0];

    // Stamp only. The value, dates and origin of the prior row are untouched —
    // the trigger would reject the statement outright if they were not.
    const upd = await q<SourceAssertion>(
      `UPDATE source_record.source_assertion
          SET status = 'SUPERSEDED'::source_record.assertion_status,
              superseded_by = $3,
              superseded_at = now()
        WHERE tenant_id = $1 AND assertion_id = $2 AND superseded_by IS NULL
        RETURNING ${ASSERTION_COLS}`,
      [input.tenant_id, input.assertion_id, next.assertion_id],
    );
    if (upd.rowCount === 0) {
      // Another writer superseded it between the read and the stamp — roll back so
      // the orphan successor is never left behind.
      throw new AssertionAlreadySuperseded(input.assertion_id, 'concurrent supersede');
    }
    return { replacement: next, stamped: upd.rows[0] };
  });

  // The replacement is a new claim like any other, so it emits the same
  // written event. Without this, a projection service tailing
  // assertion.written.v1 would silently miss every claim that arrived by
  // correction rather than by first capture.
  await emitAssertionWritten(replacement, {
    actor_id: input.actor_id,
    purpose: input.purpose,
    causation_id: input.causation_id,
  });

  await emitEvent({
    event_type: 'source-record.assertion.superseded.v1',
    pool_index: SOURCE_RECORD_AUDIT_POOL,
    actor_kind: input.actor_id ? 'human' : 'service',
    actor_id: input.actor_id || 'sdk-source-record',
    tenant_id: input.tenant_id,
    subject_kind: 'source_record.source_assertion',
    subject_id: input.assertion_id,
    payload: {
      superseded_assertion_id: stamped.assertion_id,
      superseded_by: replacement.assertion_id,
      subject_ref,
      attribute,
      prior_origin_class: stamped.origin_class,
      replacement_origin_class: replacement.origin_class,
      reason: input.reason ?? null,
      purpose: input.purpose ?? null,
      causation_id: input.causation_id ?? null,
    },
  });

  return { prior: stamped, replacement };
}

/* ------------------------------------------------------------- query */

export interface QueryAssertionsFilter {
  tenant_id: string;
  subject_ref?: string;
  attribute?: string;
  origin_class?: OriginClass;
  status?: AssertionStatus;
  /**
   * Bitemporal slice: only claims whose effective period contains this instant.
   * Omitted -> every claim regardless of period, which is the auditor's view.
   */
  effective_at?: string;
  /** Off by default: superseded claims are the point of the design, not noise. */
  exclude_superseded?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Return ALL coexisting claims for the filter, in survivorship order.
 *
 * Superseded rows are included by default. Hiding them would recreate exactly the
 * "last write wins" behaviour this SDK exists to prevent — a caller that wants a
 * single value asks sdk-projection, not this function.
 */
export async function queryAssertions(
  filter: QueryAssertionsFilter,
): Promise<SourceAssertion[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = await dataService.rows<SourceAssertion>(
    `SELECT ${ASSERTION_COLS} FROM source_record.source_assertion
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR subject_ref = $2)
        AND ($3::text IS NULL OR attribute = $3)
        AND ($4::source_record.origin_class IS NULL OR origin_class = $4::source_record.origin_class)
        AND ($5::source_record.assertion_status IS NULL OR status = $5::source_record.assertion_status)
        AND ($6::timestamptz IS NULL
             OR (effective_from <= $6::timestamptz
                 AND (effective_to IS NULL OR effective_to > $6::timestamptz)))
        AND ($7::boolean IS NOT TRUE OR status <> 'SUPERSEDED')
      ORDER BY retrieved_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [
      filter.tenant_id,
      filter.subject_ref ?? null,
      filter.attribute ?? null,
      filter.origin_class ?? null,
      filter.status ?? null,
      filter.effective_at ?? null,
      filter.exclude_superseded ?? false,
    ],
  );
  return rows.sort(survivorshipSort);
}

export async function getAssertion(
  tenant_id: string,
  assertion_id: string,
): Promise<SourceAssertion> {
  const row = await dataService.one<SourceAssertion>(
    `SELECT ${ASSERTION_COLS} FROM source_record.source_assertion
      WHERE tenant_id = $1 AND assertion_id = $2`,
    [tenant_id, assertion_id],
  );
  if (!row) throw new AssertionNotFound(assertion_id);
  return row;
}

/**
 * Reveal an enveloped value. Separate from the read path on purpose: listing
 * claims is a routine operation, reading the identifier behind one is not, and the
 * two should not share a permission.
 */
export async function revealAssertionValue(
  tenant_id: string,
  assertion_id: string,
): Promise<string | null> {
  const row = await getAssertion(tenant_id, assertion_id);
  if (row.value == null) return null;
  if (!row.value_encrypted) return row.value;
  return envelopeCipher.decrypt(row.value, {
    tenant_id,
    attribute: row.attribute,
    key_ref: row.vault_key_ref,
  });
}
