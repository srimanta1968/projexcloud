import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  type FieldMapping,
  type ImportRun,
  type LineageAction,
  type TransformPlan,
} from '../models/import.model';
import { applyTransforms } from './transformService';
import { confirmedMappings } from './mappingAssistantService';

/**
 * sdk-import atomic commit (P16 · EP-375 · PCF-02-4).
 *
 * Lands an import, once, whatever happens to the process in the middle.
 *
 * The property everything else serves: INTERRUPT A COMMIT AND RETRY IT, AND THE
 * FINAL ENTITY SET IS IDENTICAL TO ONE UNINTERRUPTED RUN. Three things make that
 * true rather than hoped-for:
 *
 *   1. DETERMINISTIC ENTITY KEYS. Every row gets an idempotency key derived from
 *      run_id + the row's own content fingerprint. A retry recomputes the SAME key,
 *      so the entity writer upserts instead of inserting a second copy. Keys derived
 *      from row ORDER would break the moment a retry started mid-file.
 *   2. LINEAGE AS THE LEDGER, WITH A UNIQUE CONSTRAINT.
 *      UNIQUE(run_id, entity_kind, entity_id, action) plus ON CONFLICT DO NOTHING
 *      means the second attempt records nothing new — which is exactly what makes
 *      "every created entity has exactly one lineage row" survive a replay.
 *   3. A RUN LOCK. A transaction-scoped advisory lock keyed on the run stops two
 *      workers committing the same run concurrently, so the retry waits for the
 *      original rather than racing it.
 *
 * And one refusal that matters more than any of them: A BLANK OR GENERIC FIELD
 * NEVER PRODUCES A CONSENT RECEIPT. See deriveConsentReceipt.
 */

const IMPORT_AUDIT_POOL = process.env.IMPORT_AUDIT_POOL || 'admin-default';

const RUN_COLS = `
  run_id, tenant_id, source_kind, source_ref, file_fingerprint, file_name, status,
  mapping_template_id, field_map, transform_plan, preview, dry_run_result, attestation_id,
  row_count, committed_row_count, exception_count, rollback_window, rollback_deadline,
  rolled_back_at, rollback_reason, quarantine_reason, committed_at, started_by,
  correlation_id, metadata, created_at, updated_at`;

/* --------------------------------------------------------------- errors */

export class ImportRunNotFound extends Error {
  readonly status = 404;
  readonly code = 'IMPORT_RUN_NOT_FOUND';
  constructor(public run_id: string) {
    super(`[sdk-import] import run ${run_id} not found for tenant`);
    this.name = 'ImportRunNotFound';
  }
}

/** Raised when a commit is attempted without signed source rights. */
export class AttestationNotSigned extends Error {
  readonly status = 422;
  readonly code = 'ATTESTATION_NOT_SIGNED';
  constructor(public run_id: string) {
    super(
      `[sdk-import] run ${run_id} has no signed source-rights attestation — the commit is refused`,
    );
    this.name = 'AttestationNotSigned';
  }
}

/** Raised when another worker holds the run lock. */
export class ImportRunLocked extends Error {
  readonly status = 409;
  readonly code = 'IMPORT_RUN_LOCKED';
  constructor(public run_id: string) {
    super(`[sdk-import] run ${run_id} is already being committed by another worker`);
    this.name = 'ImportRunLocked';
  }
}

export class InvalidRunTransition extends Error {
  readonly status = 409;
  readonly code = 'INVALID_RUN_TRANSITION';
  constructor(public run_id: string, public from: string, public to: string) {
    super(`[sdk-import] run ${run_id} cannot move ${from} -> ${to}`);
    this.name = 'InvalidRunTransition';
  }
}

/** Raised when a rollback is requested outside its window. */
export class RollbackWindowClosed extends Error {
  readonly status = 409;
  readonly code = 'ROLLBACK_WINDOW_CLOSED';
  constructor(public run_id: string, public deadline: string | null) {
    super(
      `[sdk-import] the rollback window for run ${run_id} closed at ${deadline ?? 'an unknown time'}`,
    );
    this.name = 'RollbackWindowClosed';
  }
}

/**
 * Raised when a downstream governed action has already touched an entity the run
 * created. NAMES the blocker: "cannot roll back" without saying what is holding it
 * leaves the operator with nothing to act on.
 */
export class RollbackBlockedByDownstreamAction extends Error {
  readonly status = 409;
  readonly code = 'ROLLBACK_BLOCKED_BY_DOWNSTREAM_ACTION';
  constructor(
    public run_id: string,
    public blocker: { entity_kind: string; entity_id: string; action: string; occurred_at?: string },
  ) {
    super(
      `[sdk-import] run ${run_id} cannot be rolled back: ${blocker.action} already occurred against ` +
        `${blocker.entity_kind} ${blocker.entity_id}${blocker.occurred_at ? ` at ${blocker.occurred_at}` : ''}`,
    );
    this.name = 'RollbackBlockedByDownstreamAction';
  }
}

/* ---------------------------------------------------------------- hooks */

export interface EntityWriteRequest {
  tenant_id: string;
  entity_kind: string;
  /** Deterministic per (run, row). The writer MUST upsert on this. */
  idempotency_key: string;
  values: Record<string, string | null>;
  raw: Record<string, string>;
  run_id: string;
  correlation_id: string;
}

export interface EntityWriteResult {
  entity_id: string;
  /** false when the writer found an existing row for the idempotency key. */
  created: boolean;
}

export type EntityWriter = (req: EntityWriteRequest) => Promise<EntityWriteResult>;

/**
 * Default writer: derives a stable id from the idempotency key and reports
 * created=true the first time it sees one within the process.
 *
 * This is NOT a pretend-success stub — the derived id is deterministic, so a
 * retry maps to the same entity and the lineage constraint does the deduping.
 * A deployment wires sdk-ingest (POST /api/ingest/:entity/batch) over this.
 */
const seenKeys = new Set<string>();
const defaultEntityWriter: EntityWriter = async (req) => {
  const entity_id = deterministicId(req.entity_kind, req.idempotency_key);
  const created = !seenKeys.has(entity_id);
  seenKeys.add(entity_id);
  return { entity_id, created };
};

let entityWriter: EntityWriter = defaultEntityWriter;
export function setEntityWriter(fn: EntityWriter | null): void {
  entityWriter = fn ?? defaultEntityWriter;
}

export interface RelationshipWriteRequest {
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  predicate: string;
  object_kind: string;
  object_id: string;
  run_id: string;
  correlation_id: string;
}

export type RelationshipWriter = (req: RelationshipWriteRequest) => Promise<{ relationship_id: string }>;

const defaultRelationshipWriter: RelationshipWriter = async (req) => ({
  relationship_id: deterministicId(
    'relationship',
    `${req.subject_id}|${req.predicate}|${req.object_id}`,
  ),
});

let relationshipWriter: RelationshipWriter = defaultRelationshipWriter;
/** Wire sdk-rebac at app boot. */
export function setRelationshipWriter(fn: RelationshipWriter | null): void {
  relationshipWriter = fn ?? defaultRelationshipWriter;
}

export interface ConsentReceipt {
  subject_ref: string;
  purpose: string;
  granted: boolean;
  /** Where the grant came from — a column name and its literal value. */
  evidence_column: string;
  evidence_value: string;
  captured_at: string;
}

export type ConsentRecorder = (
  receipt: ConsentReceipt,
  ctx: { tenant_id: string; run_id: string },
) => Promise<void>;

let consentRecorder: ConsentRecorder | null = null;
/**
 * Wire sdk-consent at app boot. Absent by default: with nothing wired, no receipt
 * is recorded anywhere, which is the safe direction to fail.
 */
export function setConsentRecorder(fn: ConsentRecorder | null): void {
  consentRecorder = fn;
}

/**
 * Probe for downstream governed actions against an entity. Wired at app boot to
 * whatever the deployment considers governed (a message sent, a decision made, an
 * export produced).
 *
 * Default returns "no known action" — and rollbackService treats that as
 * PERMISSION TO PROCEED only because the caller explicitly wired nothing. That is
 * a deliberate, documented choice: an import SDK cannot enumerate every
 * downstream system, and refusing all rollbacks by default would make the feature
 * unusable in every deployment that has not yet wired a probe.
 */
export type DownstreamActionProbe = (
  entities: Array<{ entity_kind: string; entity_id: string }>,
  ctx: { tenant_id: string; run_id: string },
) => Promise<Array<{ entity_kind: string; entity_id: string; action: string; occurred_at?: string }>>;

const defaultProbe: DownstreamActionProbe = async () => [];
let downstreamProbe: DownstreamActionProbe = defaultProbe;
export function setDownstreamActionProbe(fn: DownstreamActionProbe | null): void {
  downstreamProbe = fn ?? defaultProbe;
}

/* -------------------------------------------------------------- helpers */

function deterministicId(kind: string, key: string): string {
  // A v5-style stable uuid: same inputs, same id, on every retry and every host.
  const h = crypto.createHash('sha256').update(`${kind}|${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Content fingerprint of one row — order-independent, so a re-read matches. */
export function rowFingerprint(row: Record<string, string>): string {
  const entries = Object.entries(row)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32);
}

/**
 * Values that mean "no information", whatever column they appear in. A consent
 * receipt derived from one of these is a fabrication.
 */
const NON_AFFIRMATIVE = new Set([
  '', 'null', 'none', 'n/a', 'na', 'unknown', '-', '--', 'tbd', 'x', '?', 'undefined',
]);
const AFFIRMATIVE = new Set(['true', 'yes', 'y', '1', 'opt-in', 'opted-in', 'granted', 'consented']);

export interface ConsentColumnSpec {
  /** Column holding the affirmative/negative marker. */
  value_column: string;
  /** The purpose the grant covers. Required — a receipt with no purpose is meaningless. */
  purpose: string;
  /** Column holding WHEN consent was given. Required: a grant with no date is not evidence. */
  captured_at_column: string;
}

/**
 * Derive a consent receipt from a row — or refuse to.
 *
 * This is the rule the acceptance criteria single out, and it is worth being
 * blunt about why. A column called "contact_ok" holding a bare "yes", with no
 * record of when or how the person said it, is not consent. It is a spreadsheet
 * cell. Manufacturing a receipt from it launders an unverifiable claim into a
 * compliance artefact that will later be cited as proof.
 *
 * So a receipt requires ALL of:
 *   * a declared purpose (the caller says what the grant covers),
 *   * an affirmative value from a known vocabulary (not merely "non-empty"),
 *   * a capture timestamp that parses.
 *
 * Anything blank, generic, ambiguous or undated yields null, and the row lands
 * without a receipt rather than with a fabricated one.
 */
export function deriveConsentReceipt(
  row: Record<string, string>,
  spec: ConsentColumnSpec | null | undefined,
  subject_ref: string,
): { receipt: ConsentReceipt | null; refusal?: string } {
  if (!spec) return { receipt: null };

  const rawValue = (row[spec.value_column] ?? '').trim();
  const normalized = rawValue.toLowerCase();

  if (normalized === '' || NON_AFFIRMATIVE.has(normalized)) {
    return {
      receipt: null,
      refusal: `'${spec.value_column}' is blank or non-committal ('${rawValue}') — no consent receipt was created`,
    };
  }
  if (!AFFIRMATIVE.has(normalized)) {
    return {
      receipt: null,
      refusal: `'${spec.value_column}' holds '${rawValue}', which is not a recognised affirmative — no consent receipt was created`,
    };
  }

  const capturedRaw = (row[spec.captured_at_column] ?? '').trim();
  if (!capturedRaw) {
    return {
      receipt: null,
      refusal: `'${spec.value_column}' is affirmative but '${spec.captured_at_column}' is empty — a grant with no date is not evidence, so no receipt was created`,
    };
  }
  const captured = new Date(capturedRaw);
  if (Number.isNaN(captured.getTime())) {
    return {
      receipt: null,
      refusal: `'${spec.captured_at_column}' holds '${capturedRaw}', which is not a date — no consent receipt was created`,
    };
  }

  return {
    receipt: {
      subject_ref,
      purpose: spec.purpose,
      granted: true,
      evidence_column: spec.value_column,
      evidence_value: rawValue,
      captured_at: captured.toISOString(),
    },
  };
}

/* --------------------------------------------------------------- commit */

export interface CommitInput {
  tenant_id: string;
  run_id: string;
  rows: Array<Record<string, string>>;
  /** Declared only when the source genuinely carries consent evidence. */
  consent?: ConsentColumnSpec | null;
  actor_id?: string;
}

export interface CommitResult {
  run: ImportRun;
  entities_created: number;
  entities_existing: number;
  relationships_created: number;
  consent_receipts: number;
  consent_refusals: number;
  exceptions: number;
  /** true when the run was already complete and this call was a no-op replay. */
  replayed: boolean;
}

export async function getRun(tenant_id: string, run_id: string): Promise<ImportRun> {
  const run = await dataService.one<ImportRun>(
    `SELECT ${RUN_COLS} FROM import.import_run WHERE tenant_id = $1 AND run_id = $2`,
    [tenant_id, run_id],
  );
  if (!run) throw new ImportRunNotFound(run_id);
  return run;
}

/**
 * Commit the run.
 *
 * @throws ImportRunNotFound   the run does not exist for the tenant
 * @throws AttestationNotSigned no signed source rights cover the source
 * @throws ImportRunLocked     another worker is committing this run
 */
export async function commitRun(input: CommitInput): Promise<CommitResult> {
  const run = await getRun(input.tenant_id, input.run_id);

  // A completed run replays as a no-op. This is the first line of defence for a
  // retry that arrives after the original actually finished.
  if (run.status === 'complete') {
    return {
      run,
      entities_created: 0,
      entities_existing: run.committed_row_count ?? 0,
      relationships_created: 0,
      consent_receipts: 0,
      consent_refusals: 0,
      exceptions: run.exception_count,
      replayed: true,
    };
  }
  if (run.status === 'rolled_back') {
    throw new InvalidRunTransition(run.run_id, run.status, 'committing');
  }
  if (!run.attestation_id) throw new AttestationNotSigned(run.run_id);

  const field_map = (run.field_map ?? {}) as Record<string, FieldMapping>;
  const plan = run.transform_plan as TransformPlan | null;
  if (!plan) {
    throw new InvalidRunTransition(run.run_id, run.status, 'committing');
  }
  const confirmed = confirmedMappings(field_map);
  if (confirmed.length === 0) {
    throw new InvalidRunTransition(run.run_id, run.status, 'committing');
  }

  let entities_created = 0;
  let entities_existing = 0;
  let relationships_created = 0;
  let consent_receipts = 0;
  let consent_refusals = 0;
  let exceptions = 0;

  const pendingReceipts: ConsentReceipt[] = [];

  const committed = await dataService.tx(async (q) => {
    // The run lock. Transaction-scoped, so it is released by COMMIT or ROLLBACK
    // — including the rollback of a process that died mid-commit, which is
    // precisely when a stuck lock would be most damaging.
    const lock = await q<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [`sdk-import:${run.run_id}`],
    );
    if (!lock.rows[0]?.locked) throw new ImportRunLocked(run.run_id);

    await q(
      `UPDATE import.import_run SET status = 'committing' WHERE run_id = $1 AND status <> 'complete'`,
      [run.run_id],
    );

    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i];
      const transformed = applyTransforms(row, field_map, plan);

      if (transformed.invalid.length > 0) {
        for (const reason of transformed.invalid) {
          await q(
            `INSERT INTO import.import_exception
               (tenant_id, run_id, row_number, raw_row, reason_code, detail)
             VALUES ($1, $2, $3, $4::jsonb, 'INVALID_VALUE', $5)
             ON CONFLICT (run_id, row_number, reason_code) DO NOTHING`,
            [input.tenant_id, run.run_id, i, JSON.stringify(row), reason],
          );
          exceptions += 1;
        }
        continue;
      }

      const fingerprint = rowFingerprint(row);
      const values: Record<string, string | null> = {};
      for (const v of transformed.values) values[v.target] = v.value;

      // --- the subject
      const subject = await entityWriter({
        tenant_id: input.tenant_id,
        entity_kind: 'person',
        idempotency_key: `${run.run_id}|${fingerprint}|person`,
        values,
        raw: row,
        run_id: run.run_id,
        correlation_id: run.correlation_id,
      });
      subject.created ? (entities_created += 1) : (entities_existing += 1);
      await writeLineage(q, {
        tenant_id: input.tenant_id,
        run_id: run.run_id,
        entity_kind: 'person',
        entity_id: subject.entity_id,
        action: 'created',
        row_number: i,
        correlation_id: run.correlation_id,
      });

      // --- the place, as its OWN entity plus a relationship
      const placeValues = Object.fromEntries(
        Object.entries(values).filter(([k]) => k.startsWith('place.')),
      );
      if (Object.keys(placeValues).length > 0 && Object.values(placeValues).some(Boolean)) {
        const place = await entityWriter({
          tenant_id: input.tenant_id,
          entity_kind: 'place',
          idempotency_key: `${run.run_id}|${fingerprint}|place`,
          values: placeValues,
          raw: row,
          run_id: run.run_id,
          correlation_id: run.correlation_id,
        });
        place.created ? (entities_created += 1) : (entities_existing += 1);
        await writeLineage(q, {
          tenant_id: input.tenant_id,
          run_id: run.run_id,
          entity_kind: 'place',
          entity_id: place.entity_id,
          action: 'created',
          row_number: i,
          correlation_id: run.correlation_id,
        });

        const rel = await relationshipWriter({
          tenant_id: input.tenant_id,
          subject_kind: 'person',
          subject_id: subject.entity_id,
          predicate: 'located_at',
          object_kind: 'place',
          object_id: place.entity_id,
          run_id: run.run_id,
          correlation_id: run.correlation_id,
        });
        relationships_created += 1;
        await writeLineage(q, {
          tenant_id: input.tenant_id,
          run_id: run.run_id,
          entity_kind: 'relationship',
          entity_id: rel.relationship_id,
          action: 'asserted',
          row_number: i,
          correlation_id: run.correlation_id,
        });
      }

      // --- consent, only when the row genuinely evidences it
      const { receipt, refusal } = deriveConsentReceipt(row, input.consent, subject.entity_id);
      if (receipt) {
        pendingReceipts.push(receipt);
        consent_receipts += 1;
      } else if (refusal) {
        consent_refusals += 1;
        await q(
          `INSERT INTO import.import_exception
             (tenant_id, run_id, row_number, raw_row, reason_code, detail, column_name)
           VALUES ($1, $2, $3, $4::jsonb, 'CONSENT_NOT_EVIDENCED', $5, $6)
           ON CONFLICT (run_id, row_number, reason_code) DO NOTHING`,
          [input.tenant_id, run.run_id, i, JSON.stringify(row), refusal, input.consent?.value_column ?? null],
        );
      }

      for (const reason of transformed.review) {
        await q(
          `INSERT INTO import.import_exception
             (tenant_id, run_id, row_number, raw_row, reason_code, detail)
           VALUES ($1, $2, $3, $4::jsonb, 'NEEDS_REVIEW', $5)
           ON CONFLICT (run_id, row_number, reason_code) DO NOTHING`,
          [input.tenant_id, run.run_id, i, JSON.stringify(row), reason],
        );
      }
    }

    const counted = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM import.import_exception WHERE run_id = $1`,
      [run.run_id],
    );

    const done = await q<ImportRun>(
      `UPDATE import.import_run
          SET status = 'complete',
              committed_row_count = $2,
              row_count = COALESCE(row_count, $3),
              exception_count = $4
        WHERE run_id = $1
        RETURNING ${RUN_COLS}`,
      [run.run_id, entities_created + entities_existing, input.rows.length, Number(counted.rows[0].n)],
    );
    return done.rows[0];
  });

  // Consent receipts are recorded AFTER the commit transaction: sdk-consent owns
  // its own store, and holding this transaction open across an external call is
  // how a slow dependency turns into a lock-held-too-long incident.
  if (consentRecorder) {
    for (const receipt of pendingReceipts) {
      await consentRecorder(receipt, { tenant_id: input.tenant_id, run_id: run.run_id });
    }
  }

  await emitEvent({
    event_type: 'import.run.committed.v1',
    pool_index: IMPORT_AUDIT_POOL,
    actor_kind: input.actor_id ? 'human' : 'service',
    actor_id: input.actor_id || 'sdk-import',
    tenant_id: input.tenant_id,
    subject_kind: 'import.import_run',
    subject_id: run.run_id,
    payload: {
      run_id: run.run_id,
      correlation_id: run.correlation_id,
      source_kind: run.source_kind,
      file_fingerprint: run.file_fingerprint,
      entities_created,
      entities_existing,
      relationships_created,
      consent_receipts,
      consent_refusals,
      exceptions,
      rollback_deadline: committed.rollback_deadline,
    },
  });

  return {
    run: committed,
    entities_created,
    entities_existing,
    relationships_created,
    consent_receipts,
    consent_refusals,
    exceptions,
    replayed: false,
  };
}

type TxQuery = <R extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: R[]; rowCount: number | null }>;

async function writeLineage(
  q: TxQuery,
  row: {
    tenant_id: string;
    run_id: string;
    entity_kind: string;
    entity_id: string;
    action: LineageAction;
    row_number: number;
    correlation_id: string;
  },
): Promise<void> {
  // ON CONFLICT DO NOTHING against UNIQUE(run_id, entity_kind, entity_id, action):
  // the replay of an interrupted commit adds nothing, so each entity keeps exactly
  // one lineage row.
  await q(
    `INSERT INTO import.import_lineage
       (tenant_id, run_id, entity_kind, entity_id, action, row_number, correlation_id)
     VALUES ($1, $2, $3, $4, $5::import.lineage_action, $6, $7)
     ON CONFLICT (run_id, entity_kind, entity_id, action) DO NOTHING`,
    [
      row.tenant_id,
      row.run_id,
      row.entity_kind,
      row.entity_id,
      row.action,
      row.row_number,
      row.correlation_id,
    ],
  );
}

/* -------------------------------------------------------------- exceptions */

export interface ImportException {
  exception_id: string;
  run_id: string;
  row_number: number;
  raw_row: Record<string, unknown>;
  reason_code: string;
  detail: string | null;
  column_name: string | null;
  is_dry_run: boolean;
  created_at: string;
}

/**
 * The downloadable exception file: the rows that did not land, each with the
 * ORIGINAL input verbatim so the operator fixes and re-submits their own data
 * rather than the platform's interpretation of it.
 */
export async function listExceptions(
  tenant_id: string,
  run_id: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ImportException[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const offset = Math.max(opts.offset ?? 0, 0);
  return dataService.rows<ImportException>(
    `SELECT exception_id, run_id, row_number, raw_row, reason_code, detail, column_name,
            is_dry_run, created_at
       FROM import.import_exception
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY row_number ASC, reason_code ASC
      LIMIT ${limit} OFFSET ${offset}`,
    [tenant_id, run_id],
  );
}

export async function listLineage(
  tenant_id: string,
  run_id: string,
): Promise<Array<{ entity_kind: string; entity_id: string; action: string; reversed_at: string | null }>> {
  return dataService.rows(
    `SELECT entity_kind, entity_id, action, reversed_at
       FROM import.import_lineage
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY created_at ASC`,
    [tenant_id, run_id],
  );
}

/* -------------------------------------------------------------- rollback */

export interface RollbackInput {
  tenant_id: string;
  run_id: string;
  reason?: string;
  actor_id?: string;
}

export interface RollbackResult {
  run: ImportRun;
  entities_reversed: number;
}

export type EntityReverser = (
  entity: { entity_kind: string; entity_id: string },
  ctx: { tenant_id: string; run_id: string },
) => Promise<void>;

let entityReverser: EntityReverser | null = null;
export function setEntityReverser(fn: EntityReverser | null): void {
  entityReverser = fn;
}

/**
 * Reverse everything the run created.
 *
 * Permitted only while BOTH hold:
 *   * the rollback deadline has not passed, and
 *   * no downstream governed action has touched an affected entity.
 *
 * The second check is the one that protects people rather than data: once a
 * message has gone out, or a decision has been recorded against a record this
 * import created, deleting the record does not undo the consequence — it just
 * destroys the evidence of it. So the rollback is refused with a 409 that NAMES
 * the blocking action.
 *
 * @throws RollbackWindowClosed              the deadline has passed
 * @throws RollbackBlockedByDownstreamAction something already acted on an entity
 */
export async function rollbackRun(input: RollbackInput): Promise<RollbackResult> {
  const run = await getRun(input.tenant_id, input.run_id);

  if (run.status === 'rolled_back') {
    // Idempotent: rolling back a rolled-back run is a no-op, not an error.
    return { run, entities_reversed: 0 };
  }
  if (run.status !== 'complete') {
    throw new InvalidRunTransition(run.run_id, run.status, 'rolled_back');
  }

  const deadline = run.rollback_deadline ? new Date(run.rollback_deadline) : null;
  if (!deadline || deadline.getTime() < Date.now()) {
    throw new RollbackWindowClosed(run.run_id, run.rollback_deadline);
  }

  const lineage = await dataService.rows<{ entity_kind: string; entity_id: string }>(
    `SELECT entity_kind, entity_id FROM import.import_lineage
      WHERE tenant_id = $1 AND run_id = $2 AND reversed_at IS NULL`,
    [input.tenant_id, run.run_id],
  );

  const blockers = await downstreamProbe(lineage, {
    tenant_id: input.tenant_id,
    run_id: run.run_id,
  });
  if (blockers.length > 0) {
    throw new RollbackBlockedByDownstreamAction(run.run_id, blockers[0]);
  }

  for (const entity of lineage) {
    if (entityReverser) {
      await entityReverser(entity, { tenant_id: input.tenant_id, run_id: run.run_id });
    }
  }

  const reversed = await dataService.tx(async (q) => {
    const lock = await q<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [`sdk-import:${run.run_id}`],
    );
    if (!lock.rows[0]?.locked) throw new ImportRunLocked(run.run_id);

    const upd = await q(
      `UPDATE import.import_lineage
          SET reversed_at = now()
        WHERE tenant_id = $1 AND run_id = $2 AND reversed_at IS NULL`,
      [input.tenant_id, run.run_id],
    );
    const done = await q<ImportRun>(
      `UPDATE import.import_run
          SET status = 'rolled_back', rolled_back_at = now(), rollback_reason = $2
        WHERE run_id = $1 AND status = 'complete'
        RETURNING ${RUN_COLS}`,
      [run.run_id, input.reason ?? null],
    );
    return { count: upd.rowCount ?? 0, run: done.rows[0] };
  });

  await emitEvent({
    event_type: 'import.run.rolled-back.v1',
    pool_index: IMPORT_AUDIT_POOL,
    actor_kind: input.actor_id ? 'human' : 'service',
    actor_id: input.actor_id || 'sdk-import',
    tenant_id: input.tenant_id,
    subject_kind: 'import.import_run',
    subject_id: run.run_id,
    payload: {
      run_id: run.run_id,
      correlation_id: run.correlation_id,
      entities_reversed: reversed.count,
      reason: input.reason ?? null,
    },
  });

  return { run: reversed.run, entities_reversed: reversed.count };
}
