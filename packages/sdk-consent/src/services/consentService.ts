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
    `INSERT INTO consent.purpose (purpose_id, app_id, description, legal_basis, default_jurisdictions, category, segmented)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING purpose_id, app_id, description, legal_basis, default_jurisdictions, created_at, category, segmented`,
    [
      input.purpose_id,
      input.app_id,
      input.description,
      input.legal_basis,
      input.default_jurisdictions ?? [],
      input.category ?? 'general',
      input.segmented ?? false,
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
    // TWO DIFFERENT FACTS, RECORDED SEPARATELY.
    //
    // `revoked_by` is supplied in the request body: it is who the CALLER SAYS
    // performed the revocation, and nothing verifies it. `authenticated_principal`
    // is the credential the platform actually authenticated. Previously only the
    // former was stored and the audit actor was the constant 'sdk-consent.revoke',
    // so the platform's answer to "who revoked this receipt" was a string the
    // caller chose — which is precisely the question a regulator asks by name, and
    // consent revocation is the surface they ask it about.
    //
    // Recording both keeps the caller's claim (an application may legitimately be
    // acting for a named human it authenticated itself) while making the trail
    // independently checkable: a claim that disagrees with the principal is now
    // visible rather than indistinguishable.
    await emitEvent({
      event_type: 'consent.revoked.v1',
      payload: {
        receipt_id,
        revoked_by: revocation.revoked_by,
        reason: revocation.reason,
        authenticated_principal: input.authenticated_principal ?? null,
        actor_kind: input.authenticated_actor_kind ?? null,
      },
      pool_index: POOL_INDEX,
      // Falls back to the old constant only when no principal was threaded
      // through — an in-process caller rather than an HTTP one.
      actor_kind: input.authenticated_actor_kind ?? 'service',
      actor_id: input.authenticated_principal ?? 'sdk-consent.revoke',
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

export interface ListPurposesFilter {
  app_id?: string;
  category?: string;
  legal_basis?: string;
  limit?: number;
  offset?: number;
}

export interface ListPurposesResult {
  purposes: PurposeRecord[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Reads the purpose registry — what `POST /api/consents/purposes` writes into.
 *
 * WHY THIS IS NOT TENANT-SCOPED, WHICH IS UNUSUAL HERE AND DELIBERATE.
 *
 * `consent.purpose.purpose_id` is a TEXT PRIMARY KEY: the registry is a single
 * PLATFORM-WIDE namespace by construction, not a per-tenant one. Two tenants
 * cannot both register 'marketing-email' — the second gets 409 Conflict, which
 * already discloses that the first exists. Scoping the read while leaving the
 * write globally unique would hide names that the write path reveals on the very
 * next collision, which is worse than either choice made consistently: an
 * integrator would see an empty list, register the obvious id, take a 409, and
 * have no way to find out what it collided with.
 *
 * The table carries no tenant_id to scope BY, and inferring one from app_id is
 * not available either — app_id here is a free-form string chosen by whoever
 * registered the purpose, not the api_keys.application id a credential carries.
 *
 * So: the registry is global, and this reports it as global. The consequence
 * worth stating plainly is that `description` is readable by any authenticated
 * tenant. Purposes are a legal taxonomy rather than customer data, so that is
 * defensible, but it is a product decision and not merely an implementation
 * detail — if it must become per-tenant, purpose_id has to stop being the global
 * primary key first, and that is a schema change with an FK from every receipt.
 */
export async function listPurposes(filter: ListPurposesFilter = {}): Promise<ListPurposesResult> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const params = [
    filter.app_id ?? null,
    filter.category ?? null,
    filter.legal_basis ?? null,
  ];
  const where = `WHERE ($1::text IS NULL OR app_id = $1)
                   AND ($2::text IS NULL OR category = $2)
                   AND ($3::text IS NULL OR legal_basis = $3)`;

  // Total is reported alongside the page so a caller can tell "this is all of
  // them" from "this is the first hundred" — the difference between a complete
  // taxonomy panel and one that quietly truncates.
  const countRow = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM consent.purpose ${where}`,
    params,
  );
  const purposes = await dataService.rows<PurposeRecord>(
    `SELECT purpose_id, app_id, description, legal_basis, default_jurisdictions,
            created_at, category, segmented
       FROM consent.purpose
     ${where}
      ORDER BY app_id, purpose_id
      LIMIT $4 OFFSET $5`,
    [...params, limit, offset],
  );
  return { purposes, total: Number(countRow?.n ?? 0), limit, offset };
}

/** One tuple in a bulk consent check, carrying the caller's slot for it. */
export interface BulkCheckItem extends CheckConsentInput {
  index: number;
}

export interface BulkCheckRow extends CheckConsentResult {
  index: number;
}

/**
 * checkConsent for N tuples in ONE round trip and ONE query.
 *
 * The point is not saving HTTP overhead — it is that the composer's alternative
 * is N sequential calls, deliberately sequential because firing them at once
 * trips the rate limiter and then the circuit breaker for every other consumer
 * of this SDK. At four upstream checks per subject a 100k audience is 400k
 * sequential calls; the arithmetic does not fit in any request budget, and
 * parallelising it converts one caller's latency problem into everyone's outage.
 *
 * So this must be genuinely set-based. A loop over checkConsent() behind a bulk
 * route would look like a fix and move the same N queries one layer down.
 *
 * The DISTINCT ON reproduces the single-tuple `ORDER BY granted_at DESC LIMIT 1`
 * exactly, per input row — including the case where the same tuple appears twice
 * in one batch, which gets the same verdict in both slots rather than one of them
 * silently dropping out of the join.
 */
export async function checkConsentBulk(items: BulkCheckItem[]): Promise<BulkCheckRow[]> {
  if (items.length === 0) return [];
  const rows = await dataService.rows<{
    idx: number;
    receipt_id: string | null;
    granted_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `WITH q AS (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[])
         AS t(person_id, purpose_id, processor, jurisdiction, idx)
     )
     SELECT DISTINCT ON (q.idx)
            q.idx,
            r.receipt_id, r.granted_at, r.expires_at, r.revoked_at
       FROM q
       LEFT JOIN consent.receipt r
         ON r.person_id    = q.person_id
        AND r.purpose_id   = q.purpose_id
        AND r.processor    = q.processor
        AND r.jurisdiction = q.jurisdiction
      ORDER BY q.idx, r.granted_at DESC`,
    [
      items.map((i) => i.person_id),
      items.map((i) => i.purpose_id),
      items.map((i) => i.processor),
      items.map((i) => i.jurisdiction),
      items.map((i) => i.index),
    ],
  );

  const now = Date.now();
  return rows.map((row) => {
    if (!row.receipt_id) {
      return {
        index: row.idx,
        granted: false,
        receipt_id: null,
        granted_at: null,
        expires_at: null,
        revoked_at: null,
      };
    }
    const expired = row.expires_at != null && new Date(row.expires_at).getTime() <= now;
    const revoked = row.revoked_at != null;
    return {
      index: row.idx,
      granted: !expired && !revoked,
      receipt_id: row.receipt_id,
      granted_at: row.granted_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
    };
  });
}

/**
 * Exports all receipts for a person (or whole tenant scope when person_id is
 * absent) as a JSONL-friendly array. Composes with sdk-audit signed PDF export
 * for regulator self-service.
 */
export interface ReceiptStateResult {
  receipt_id: string;
  person_id: string;
  purpose_id: string;
  processor: string;
  jurisdiction: string;
  app_id: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  /** True only when not revoked AND not past expiry — the question a caller actually has. */
  active: boolean;
  revoked: boolean;
  expired: boolean;
}

/**
 * The state of ONE receipt, by id — "is the basis I recorded still valid?".
 *
 * WHY THIS EXISTS ALONGSIDE checkConsent, which answers a DIFFERENT question.
 *
 * checkConsent asks a POLICY question: is there any active receipt for
 * (person, purpose, processor, jurisdiction) right now. That is the right question on
 * the hot path, before you touch PII.
 *
 * This asks an AUDIT question: the specific consent under which a thing was already
 * captured — a call recording, an export — is it still good. Those come apart exactly
 * when it matters. If the original basis is revoked and a NEW consent is later granted
 * for the same purpose, checkConsent answers yes, because a valid receipt exists. But
 * the recording in hand was made under the revoked one, and continuing to process it on
 * the strength of a different, later consent is precisely the substitution an auditor
 * would object to.
 *
 * So a caller holding an opaque basis_ref should read THE RECEIPT, not re-ask the
 * policy question. The four-tuple is returned too, so a caller that also wants the
 * policy answer can call checkConsent without having stored anything extra.
 *
 * TENANT SCOPING is applied in SQL and is not optional. A receipt names a person, a
 * purpose and a processor; being able to read one by guessing an id would leak who
 * consented to what. A receipt outside the caller's tenant is reported as absent
 * rather than forbidden, so probing an id cannot confirm it exists elsewhere.
 */
export async function getReceiptState(
  receipt_id: string,
  tenant_id: string,
): Promise<ReceiptStateResult | null> {
  const row = await dataService.one<{
    receipt_id: string;
    person_id: string;
    purpose_id: string;
    processor: string;
    jurisdiction: string;
    app_id: string;
    granted_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    `SELECT receipt_id::text, person_id::text, purpose_id, processor, jurisdiction, app_id,
            granted_at, expires_at, revoked_at
       FROM consent.receipt
      WHERE receipt_id = $1::uuid
        AND (source_tenant_id = $2::uuid OR target_tenant_id = $2::uuid)
      LIMIT 1`,
    [receipt_id, tenant_id],
  );
  if (!row) return null;
  const revoked = row.revoked_at !== null;
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
  return { ...row, revoked, expired, active: !revoked && !expired };
}

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
