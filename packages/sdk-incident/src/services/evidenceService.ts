import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  EVIDENCE_SUMMARY_COLUMN,
  type AppendEvidenceInput,
  type EvidenceKind,
  type EvidenceRecord,
} from '../models/evidence.model';

/**
 * sdk-incident evidence timeline (P15·E3, TK-3651).
 *
 * Every timeline entry is written to the sdk-audit hash-chained ledger FIRST and
 * the resulting entry id / seq / entry_hash are stored on the evidence row as an
 * immutability receipt. The audit chain is the tamper-evident record of record;
 * incident.evidence is the queryable projection of it, and the table's
 * append-only trigger (migration 002) blocks UPDATE/DELETE outright — so
 * evidence can be added but never rewritten or erased.
 */

const INCIDENT_AUDIT_POOL = process.env.INCIDENT_AUDIT_POOL || 'admin-default';

const EVIDENCE_COLS = `
  evidence_id, tenant_id, incident_id, kind, body, evidence_ref,
  recorded_by_persona_id, occurred_at, audit_entry_id, audit_seq,
  audit_entry_hash, metadata, created_at`;

/** Thrown when evidence is appended to an incident that does not exist for the tenant. */
export class IncidentNotFound extends Error {
  constructor(public incident_id: string) {
    super(`[sdk-incident] incident ${incident_id} not found for tenant`);
    this.name = 'IncidentNotFound';
  }
}

/**
 * Append one entry to an incident's evidence timeline.
 *
 * Order matters: the sdk-audit entry is written before the row so the receipt can
 * be stored with it. If the audit emit is unavailable, emitEvent returns null (it
 * is best-effort by design and never throws) and the evidence is still recorded —
 * with null receipt columns marking it as un-notarised rather than silently lost.
 *
 * Appending 'root_cause' / 'recovery' / 'verification' also projects the body onto
 * the matching incident summary column, and 'detected' stamps detected_at when it
 * is not already set, so the record and its timeline stay consistent.
 *
 * @throws IncidentNotFound when the incident does not exist for that tenant.
 */
export async function appendEvidence(input: AppendEvidenceInput): Promise<EvidenceRecord> {
  const incident = await dataService.one<{ incident_id: string; incident_type: string; severity: string; status: string }>(
    `SELECT incident_id, incident_type, severity, status
       FROM incident.incident WHERE tenant_id = $1 AND incident_id = $2`,
    [input.tenant_id, input.incident_id],
  );
  if (!incident) throw new IncidentNotFound(input.incident_id);

  const entry = await emitEvent({
    event_type: 'incident.evidence.recorded.v1',
    pool_index: INCIDENT_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-incident',
    tenant_id: input.tenant_id,
    subject_kind: 'incident.incident',
    subject_id: input.incident_id,
    payload: {
      incident_id: input.incident_id,
      incident_type: incident.incident_type,
      status: incident.status,
      severity: incident.severity,
      kind: input.kind,
      body: input.body,
      evidence_ref: input.evidence_ref ?? null,
      recorded_by_persona_id: input.recorded_by_persona_id ?? null,
    },
  });

  const rec = await dataService.one<EvidenceRecord>(
    `INSERT INTO incident.evidence
       (tenant_id, incident_id, kind, body, evidence_ref, recorded_by_persona_id,
        occurred_at, audit_entry_id, audit_seq, audit_entry_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10,
             COALESCE($11::jsonb, '{}'::jsonb))
     RETURNING ${EVIDENCE_COLS}`,
    [
      input.tenant_id,
      input.incident_id,
      input.kind,
      input.body,
      input.evidence_ref ?? null,
      input.recorded_by_persona_id ?? null,
      input.occurred_at ?? null,
      entry?.entry_id ?? null,
      entry?.seq ?? null,
      entry ? entry.entry_hash.toString('hex') : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!rec) throw new Error('[sdk-incident] evidence insert returned no row');

  await projectOntoIncident(input.tenant_id, input.incident_id, input.kind, input.body);
  return rec;
}

/**
 * Keep the incident record in step with its timeline: summarise the latest
 * root_cause/recovery/verification onto the matching column, and let the first
 * 'detected' entry stamp detected_at (COALESCE keeps the original detection time
 * if one was already recorded at creation).
 */
async function projectOntoIncident(
  tenant_id: string,
  incident_id: string,
  kind: EvidenceKind,
  body: string,
): Promise<void> {
  const column = EVIDENCE_SUMMARY_COLUMN[kind];
  if (column) {
    // `column` comes from a fixed internal map keyed by the validated kind enum —
    // never from request input — so it is safe to interpolate.
    await dataService.rows(
      `UPDATE incident.incident SET ${column} = $3, updated_at = now()
        WHERE tenant_id = $1 AND incident_id = $2`,
      [tenant_id, incident_id, body],
    );
    return;
  }
  if (kind === 'detected') {
    await dataService.rows(
      `UPDATE incident.incident SET detected_at = COALESCE(detected_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND incident_id = $2`,
      [tenant_id, incident_id],
    );
  }
}

/**
 * Read an incident's evidence timeline in chronological order (oldest first),
 * optionally filtered to one kind. Tenant-scoped; an unknown incident simply
 * yields an empty timeline.
 */
export async function listEvidence(
  tenant_id: string,
  incident_id: string,
  opts: { kind?: string; limit?: number; offset?: number } = {},
): Promise<EvidenceRecord[]> {
  return dataService.rows<EvidenceRecord>(
    `SELECT ${EVIDENCE_COLS}
       FROM incident.evidence
      WHERE tenant_id = $1 AND incident_id = $2
        AND ($3::text IS NULL OR kind = $3)
      ORDER BY occurred_at ASC, created_at ASC
      LIMIT $4 OFFSET $5`,
    [tenant_id, incident_id, opts.kind ?? null, opts.limit ?? 200, opts.offset ?? 0],
  );
}
