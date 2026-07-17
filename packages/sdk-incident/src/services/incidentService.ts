import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  isValidTransition,
  INCIDENT_TRANSITION_TIMESTAMP,
  type CreateIncidentInput,
  type IncidentRecord,
  type IncidentStatus,
  type UpdateIncidentInput,
} from '../models/incident.model';

/**
 * sdk-incident service (P15·E3) — exception/incident CRUD, status lifecycle,
 * and SLA-breach scan. Reuses the sdk-service-request SLA pattern.
 *
 * Lifecycle: open -> investigating -> mitigated -> resolved -> closed
 * (resolved may re-open to investigating; cancellable while pre-resolved).
 * Every transition is validated, stamps the matching timestamp, and emits a
 * lifecycle event through sdk-audit. All queries are tenant-scoped.
 */

const INCIDENT_AUDIT_POOL = process.env.INCIDENT_AUDIT_POOL || 'admin-default';

const INCIDENT_COLS = `
  incident_id, tenant_id, incident_type, title, description, severity, status,
  affected_records, root_cause, recovery, verification, owner_persona_id,
  reported_by_persona_id, source, subject_ref, sla_due_at, metadata,
  opened_at, detected_at, resolved_at, closed_at, created_at, updated_at`;

/** Thrown when a requested status transition is not allowed from the current state. */
export class InvalidIncidentTransition extends Error {
  constructor(public from: IncidentStatus, public to: IncidentStatus) {
    super(`[sdk-incident] invalid transition ${from} -> ${to}`);
    this.name = 'InvalidIncidentTransition';
  }
}

async function emitIncidentEvent(
  event_type: string,
  rec: IncidentRecord,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await emitEvent({
    event_type,
    pool_index: INCIDENT_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-incident',
    tenant_id: rec.tenant_id,
    subject_kind: 'incident.incident',
    subject_id: rec.incident_id,
    payload: {
      incident_id: rec.incident_id,
      incident_type: rec.incident_type,
      severity: rec.severity,
      status: rec.status,
      owner_persona_id: rec.owner_persona_id,
      ...extra,
    },
  });
}

/** Create an incident in status 'open'. Emits incident.opened.v1. */
export async function createIncident(input: CreateIncidentInput): Promise<IncidentRecord> {
  const rec = await dataService.one<IncidentRecord>(
    `INSERT INTO incident.incident
       (tenant_id, incident_type, title, description, severity, affected_records,
        owner_persona_id, reported_by_persona_id, source, subject_ref, sla_due_at,
        detected_at, metadata)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'medium'),
             COALESCE($6::jsonb, '[]'::jsonb), $7, $8, $9, $10, $11, $12,
             COALESCE($13::jsonb, '{}'::jsonb))
     RETURNING ${INCIDENT_COLS}`,
    [
      input.tenant_id,
      input.incident_type,
      input.title,
      input.description ?? null,
      input.severity ?? null,
      input.affected_records ? JSON.stringify(input.affected_records) : null,
      input.owner_persona_id ?? null,
      input.reported_by_persona_id ?? null,
      input.source ?? null,
      input.subject_ref ?? null,
      input.sla_due_at ?? null,
      input.detected_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!rec) throw new Error('[sdk-incident] insert returned no row');
  await emitIncidentEvent('incident.opened.v1', rec);
  return rec;
}

/** Fetch a single tenant-scoped incident, or null when not found. */
export async function getIncident(tenant_id: string, incident_id: string): Promise<IncidentRecord | null> {
  return dataService.one<IncidentRecord>(
    `SELECT ${INCIDENT_COLS} FROM incident.incident WHERE tenant_id = $1 AND incident_id = $2`,
    [tenant_id, incident_id],
  );
}

/** List tenant-scoped incidents, optionally filtered by status / severity / owner. */
export async function listIncidents(
  tenant_id: string,
  opts: { status?: string; severity?: string; owner_persona_id?: string; limit?: number; offset?: number } = {},
): Promise<IncidentRecord[]> {
  return dataService.rows<IncidentRecord>(
    `SELECT ${INCIDENT_COLS}
       FROM incident.incident
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR severity = $3)
        AND ($4::uuid IS NULL OR owner_persona_id = $4)
      ORDER BY updated_at DESC
      LIMIT $5 OFFSET $6`,
    [tenant_id, opts.status ?? null, opts.severity ?? null, opts.owner_persona_id ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
}

/**
 * Update editable incident fields (including owner assignment and SLA deadline).
 * Status is NOT editable here — use transitionIncident. Emits incident.updated.v1.
 * Returns null when the incident is not found.
 */
export async function updateIncident(
  tenant_id: string,
  incident_id: string,
  patch: UpdateIncidentInput,
): Promise<IncidentRecord | null> {
  const rec = await dataService.one<IncidentRecord>(
    `UPDATE incident.incident SET
        title            = COALESCE($3, title),
        description      = COALESCE($4, description),
        severity         = COALESCE($5::text, severity),
        affected_records = COALESCE($6::jsonb, affected_records),
        root_cause       = COALESCE($7, root_cause),
        recovery         = COALESCE($8, recovery),
        verification     = COALESCE($9, verification),
        owner_persona_id = COALESCE($10, owner_persona_id),
        subject_ref      = COALESCE($11, subject_ref),
        sla_due_at       = COALESCE($12, sla_due_at),
        metadata         = COALESCE($13::jsonb, metadata),
        updated_at       = now()
      WHERE tenant_id = $1 AND incident_id = $2
      RETURNING ${INCIDENT_COLS}`,
    [
      tenant_id,
      incident_id,
      patch.title ?? null,
      patch.description ?? null,
      patch.severity ?? null,
      patch.affected_records ? JSON.stringify(patch.affected_records) : null,
      patch.root_cause ?? null,
      patch.recovery ?? null,
      patch.verification ?? null,
      patch.owner_persona_id ?? null,
      patch.subject_ref ?? null,
      patch.sla_due_at ?? null,
      patch.metadata ? JSON.stringify(patch.metadata) : null,
    ],
  );
  if (rec) await emitIncidentEvent('incident.updated.v1', rec);
  return rec;
}

/**
 * Transition an incident to a new status. Validates against INCIDENT_TRANSITIONS,
 * stamps the matching timestamp, and emits incident.transitioned.v1 with from/to.
 *
 * @returns the updated record, or null when the incident is not found.
 * @throws InvalidIncidentTransition when the transition is not allowed.
 */
export async function transitionIncident(
  tenant_id: string,
  incident_id: string,
  to: IncidentStatus,
): Promise<IncidentRecord | null> {
  const current = await dataService.one<{ status: IncidentStatus }>(
    `SELECT status FROM incident.incident WHERE tenant_id = $1 AND incident_id = $2`,
    [tenant_id, incident_id],
  );
  if (!current) return null;
  if (!isValidTransition(current.status, to)) {
    throw new InvalidIncidentTransition(current.status, to);
  }

  const tsCol = INCIDENT_TRANSITION_TIMESTAMP[to];
  const setTimestamp = tsCol ? `, ${tsCol} = now()` : '';
  const rec = await dataService.one<IncidentRecord>(
    `UPDATE incident.incident
        SET status = $3, updated_at = now()${setTimestamp}
      WHERE tenant_id = $1 AND incident_id = $2
      RETURNING ${INCIDENT_COLS}`,
    [tenant_id, incident_id, to],
  );
  if (!rec) return null;
  await emitIncidentEvent('incident.transitioned.v1', rec, { from: current.status, to });
  return rec;
}

/**
 * SLA-breach scan: tenant-scoped incidents whose sla_due_at is past and whose
 * status is still active (not resolved/closed/cancelled). Powered by the partial
 * incident_sla_idx. Read-only; the scheduler calls notifySlaBreach to alert.
 */
export async function findSlaBreaches(
  tenant_id: string,
  opts: { limit?: number } = {},
): Promise<IncidentRecord[]> {
  return dataService.rows<IncidentRecord>(
    `SELECT ${INCIDENT_COLS}
       FROM incident.incident
      WHERE tenant_id = $1
        AND status NOT IN ('resolved','closed','cancelled')
        AND sla_due_at IS NOT NULL
        AND sla_due_at < now()
      ORDER BY sla_due_at ASC
      LIMIT $2`,
    [tenant_id, opts.limit ?? 100],
  );
}

/** Emit an incident.sla.breached.v1 event for a breached incident (scheduler use). */
export async function notifySlaBreach(incident: IncidentRecord): Promise<void> {
  await emitIncidentEvent('incident.sla.breached.v1', incident, { sla_due_at: incident.sla_due_at });
}
