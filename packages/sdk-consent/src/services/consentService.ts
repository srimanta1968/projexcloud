import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { enqueueProjectionRefresh } from '@projexlight/sdk-projection';
import { checkCrossBorder } from './crossBorderPolicy';

const POOL_INDEX = process.env.POOL_INDEX || 'admin';

export class CrossBorderError extends Error {
  readonly code = 'CrossBorderViolation';
  constructor(message: string) { super(message); this.name = 'CrossBorderError'; }
}
import type {
  CheckConsentInput,
  CheckConsentResult,
  GrantConsentInput,
  PurposeRecord,
  ReceiptRecord,
  RegisterPurposeInput,
  RevocationRecord,
  RevokeConsentInput,
} from '../models/consent.model';

/**
 * sdk-consent service layer per P2 §5.3 / FR-CNS-1..6.
 * All writes route through @projexlight/db-runtime — never a raw pg.Client (OC-3).
 */

function evidenceHash(input: GrantConsentInput, granted_at: Date): Buffer {
  const canonical = JSON.stringify({
    person_id: input.person_id,
    purpose_id: input.purpose_id,
    processor: input.processor,
    app_id: input.app_id,
    jurisdiction: input.jurisdiction,
    granted_by_actor: input.granted_by_actor,
    granted_at: granted_at.toISOString(),
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

/**
 * Registers a new purpose in the per-app registry (FR-CNS-4). Idempotent on
 * purpose_id — second insert with same id throws via PK violation.
 */
export async function registerPurpose(input: RegisterPurposeInput): Promise<PurposeRecord> {
  const rows = await dataService.rows<PurposeRecord>(
    `INSERT INTO consent.purpose (purpose_id, app_id, description, legal_basis, default_jurisdictions)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING purpose_id, app_id, description, legal_basis, default_jurisdictions, created_at`,
    [
      input.purpose_id,
      input.app_id,
      input.description,
      input.legal_basis,
      input.default_jurisdictions ?? [],
    ],
  );
  const purpose = rows[0];
  await emitEvent({
    event_type: 'consent.purpose.registered.v1',
    payload: {
      purpose_id: purpose.purpose_id,
      app_id: purpose.app_id,
      legal_basis: purpose.legal_basis,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-consent.registerPurpose',
    app_id: purpose.app_id,
    subject_kind: 'consent.purpose',
    subject_id: purpose.purpose_id,
  });
  return purpose;
}

/**
 * Grants a consent receipt keyed by (person_id, purpose_id, processor, app_id, jurisdiction).
 * If a previous receipt exists with the same key and was revoked, this insert fails on
 * the UNIQUE constraint — callers must revoke-then-grant explicitly to re-issue.
 */
export async function grantConsent(input: GrantConsentInput): Promise<ReceiptRecord> {
  // FR-CNS-5: cross-border enforcement. Look up the person's home_region and
  // refuse to issue a receipt when the processor's jurisdiction lacks an EU
  // adequacy decision (caller can override by passing a special cross-border
  // purpose explicitly registered for that flow).
  const person = await dataService.one<{ home_region: string }>(
    `SELECT home_region FROM identity.person WHERE person_id = $1`,
    [input.person_id],
  );
  if (person) {
    const bordered = checkCrossBorder({
      person_home_region: person.home_region,
      processor_jurisdiction: input.jurisdiction,
    });
    if (!bordered.allowed && !input.purpose_id.startsWith('cross-border-')) {
      throw new CrossBorderError(bordered.reason);
    }
  }

  const granted_at = new Date();
  const hash = evidenceHash(input, granted_at);
  const rows = await dataService.rows<ReceiptRecord>(
    `INSERT INTO consent.receipt (
        person_id, purpose_id, processor, app_id, jurisdiction,
        granted_by_actor, granted_at, expires_at,
        source_tenant_id, target_tenant_id, evidence_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING receipt_id, person_id, purpose_id, processor, app_id, jurisdiction,
               granted_by_actor, granted_at, expires_at,
               source_tenant_id, target_tenant_id, revoked_at, revocation_id, evidence_hash`,
    [
      input.person_id,
      input.purpose_id,
      input.processor,
      input.app_id,
      input.jurisdiction,
      input.granted_by_actor,
      granted_at,
      input.expires_at ? new Date(input.expires_at) : null,
      input.source_tenant_id ?? null,
      input.target_tenant_id ?? null,
      hash,
    ],
  );
  const receipt = rows[0];
  // Audit + projection fan-out
  const isCrossTenant = Boolean(input.source_tenant_id || input.target_tenant_id);
  await emitEvent({
    event_type: isCrossTenant ? 'consent.cross-tenant.granted.v1' : 'consent.granted.v1',
    payload: {
      receipt_id: receipt.receipt_id,
      person_id: receipt.person_id,
      purpose_id: receipt.purpose_id,
      processor: receipt.processor,
      app_id: receipt.app_id,
      jurisdiction: receipt.jurisdiction,
      source_tenant_id: receipt.source_tenant_id,
      target_tenant_id: receipt.target_tenant_id,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-consent.grant',
    tenant_id: receipt.target_tenant_id ?? receipt.source_tenant_id ?? null,
    app_id: receipt.app_id,
    subject_kind: 'person',
    subject_id: receipt.person_id,
  });
  await enqueueProjectionRefresh({ person_id: receipt.person_id });
  return receipt;
}

/**
 * Revokes a receipt. Append-only — writes a revocation row AND stamps the
 * parent receipt with revoked_at + revocation_id in a single transaction so
 * downstream queries can use the indexed `revoked_at IS NULL` partial index.
 */
export async function revokeConsent(receipt_id: string, input: RevokeConsentInput): Promise<RevocationRecord> {
  const revoked_at = new Date();
  const rows = await dataService.rows<RevocationRecord>(
    `WITH ins AS (
       INSERT INTO consent.revocation (receipt_id, revoked_by, reason, revoked_at)
       VALUES ($1, $2, $3, $4)
       RETURNING revocation_id, receipt_id, revoked_by, reason, revoked_at
     ), upd AS (
       UPDATE consent.receipt
          SET revoked_at = $4,
              revocation_id = (SELECT revocation_id FROM ins)
        WHERE receipt_id = $1
       RETURNING receipt_id
     )
     SELECT revocation_id, receipt_id, revoked_by, reason, revoked_at FROM ins`,
    [receipt_id, input.revoked_by, input.reason, revoked_at],
  );
  if (rows.length === 0) {
    throw new Error(`Receipt ${receipt_id} not found`);
  }
  const revocation = rows[0];
  // Look up the receipt for fan-out context
  const receipt = await dataService.one<{ person_id: string; tenant_id: string | null }>(
    `SELECT person_id, COALESCE(target_tenant_id, source_tenant_id) AS tenant_id
       FROM consent.receipt WHERE receipt_id = $1`,
    [receipt_id],
  );
  if (receipt) {
    await emitEvent({
      event_type: 'consent.revoked.v1',
      payload: { receipt_id, revoked_by: revocation.revoked_by, reason: revocation.reason },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-consent.revoke',
      tenant_id: receipt.tenant_id,
      subject_kind: 'person',
      subject_id: receipt.person_id,
    });
    await enqueueProjectionRefresh({ person_id: receipt.person_id });
  }
  return revocation;
}

/**
 * Reads the active receipt for the (person_id, purpose_id, processor, jurisdiction)
 * tuple. Used by every downstream SDK before processing PII (FR-CNS-1, FR-CNS-5).
 * The partial index `receipt_active_idx` makes this a sub-ms point query.
 */
export async function checkConsent(input: CheckConsentInput): Promise<CheckConsentResult> {
  const row = await dataService.one<{
    receipt_id: string;
    granted_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT receipt_id, granted_at, expires_at, revoked_at
       FROM consent.receipt
      WHERE person_id   = $1
        AND purpose_id  = $2
        AND processor   = $3
        AND jurisdiction = $4
      ORDER BY granted_at DESC
      LIMIT 1`,
    [input.person_id, input.purpose_id, input.processor, input.jurisdiction],
  );
  if (!row) {
    return { granted: false, receipt_id: null, granted_at: null, expires_at: null, revoked_at: null };
  }
  const now = Date.now();
  const expired = row.expires_at != null && row.expires_at.getTime() <= now;
  const revoked = row.revoked_at != null;
  return {
    granted: !expired && !revoked,
    receipt_id: row.receipt_id,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

/**
 * Exports all receipts for a person (or whole tenant scope when person_id is
 * absent) as a JSONL-friendly array. Composes with sdk-audit signed PDF export
 * for regulator self-service.
 */
export async function exportReceipts(person_id?: string): Promise<ReceiptRecord[]> {
  if (person_id) {
    return dataService.rows<ReceiptRecord>(
      `SELECT receipt_id, person_id, purpose_id, processor, app_id, jurisdiction,
              granted_by_actor, granted_at, expires_at,
              source_tenant_id, target_tenant_id, revoked_at, revocation_id, evidence_hash
         FROM consent.receipt
        WHERE person_id = $1
        ORDER BY granted_at DESC`,
      [person_id],
    );
  }
  return dataService.rows<ReceiptRecord>(
    `SELECT receipt_id, person_id, purpose_id, processor, app_id, jurisdiction,
            granted_by_actor, granted_at, expires_at,
            source_tenant_id, target_tenant_id, revoked_at, revocation_id, evidence_hash
       FROM consent.receipt
      ORDER BY granted_at DESC
      LIMIT 1000`,
  );
}
