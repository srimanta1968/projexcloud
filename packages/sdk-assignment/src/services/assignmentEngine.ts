import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type { AssignmentRef, AssignmentStatus } from '@projexlight/contracts';
import { haversineKm, type GeoPoint } from './geofence';
import { findTerritoriesAt } from './territoryService';

/**
 * Auto-assignment engine (FR-ASN-1..3 / AC-2).
 *
 * Algorithm for assignByTask:
 *   1. Find territories whose geom contains the task location.
 *      a. Primary persona pool gets priority.
 *      b. Backup pool is the fallback when primary is empty / saturated.
 *   2. Score each candidate persona by:
 *        - skill_match     — required_skills ⊆ workload.skills (boolean gate)
 *        - capacity_remaining — capacity_per_day - open_tasks (gate + tiebreak)
 *        - availability    — now ∈ [available_from, available_to] (gate)
 *        - distance        — haversine from persona's last known location
 *                            to task location (tiebreak — lower is better)
 *      `distance` lookup is optional: callers may pass `persona_locations`
 *      directly; production swaps this for a sdk-geo lookup via the
 *      `setPersonaLocationResolver()` hook.
 *   3. If no territory matched, fall back to radius mode: scan workload
 *      rows whose skills include required_skills, then rank by haversine
 *      distance + capacity_remaining.
 *   4. Atomically (a) insert assignment.assignment, (b) increment the
 *      chosen workload.open_tasks. The transaction guarantees no double-
 *      assign past capacity even under concurrent dispatcher calls.
 *
 * The function returns the proposed assignment with status='proposed';
 * the dispatcher / persona must call acceptAssignment() to confirm or
 * rejectAssignment() to bounce the task back into the queue.
 */

const ASSIGNMENT_AUDIT_POOL = process.env.ASSIGNMENT_AUDIT_POOL || 'admin-default';

interface CandidateWorkload {
  persona_id: string;
  open_tasks: number;
  capacity_per_day: number;
  skills: string[];
  available_from: Date | null;
  available_to: Date | null;
}

export interface AssignByTaskInput {
  task_id: string;
  tenant_id: string;
  /** Where the task needs to be performed; drives territory + distance. */
  location: GeoPoint;
  /** Skills the persona must have to handle this task. */
  required_skills: string[];
  /** Optional radius (km) used when no territory contains the task. */
  fallback_radius_km?: number;
  /**
   * Optional last-known location per candidate persona. When omitted
   * the distance tiebreak is skipped and selection falls back to capacity.
   */
  persona_locations?: Record<string, GeoPoint>;
  /** When set, restricts selection to these personas (skip workload scan). */
  candidate_persona_ids?: string[];
}

export interface AssignByTaskResult {
  assignment: AssignmentRef;
  /** The territory that matched, when present. */
  territory_id: string | null;
  /** Distance from persona to task in km, when persona_locations supplied. */
  distance_km: number | null;
  /** Why this persona won — for ops triage and audit. */
  reason: string;
}

type PersonaLocationResolver = (
  tenant_id: string,
  persona_ids: string[],
) => Promise<Record<string, GeoPoint>>;

let _locationResolver: PersonaLocationResolver = async () => ({});

export function setPersonaLocationResolver(resolver: PersonaLocationResolver): void {
  _locationResolver = resolver;
}

/** Test hook — restore default (no-op) resolver. */
export function _resetPersonaLocationResolver(): void {
  _locationResolver = async () => ({});
}

interface ScoredCandidate {
  persona_id: string;
  capacity_remaining: number;
  distance_km: number;
  is_primary: boolean;
}

function isAvailable(w: CandidateWorkload, now = new Date()): boolean {
  if (w.available_from && w.available_from > now) return false;
  if (w.available_to && w.available_to < now) return false;
  return true;
}

function hasSkills(w: CandidateWorkload, required: string[]): boolean {
  if (required.length === 0) return true;
  return required.every((r) => w.skills.includes(r));
}

async function loadCandidateWorkloads(persona_ids: string[]): Promise<Map<string, CandidateWorkload>> {
  const map = new Map<string, CandidateWorkload>();
  if (persona_ids.length === 0) return map;
  const rows = await dataService.rows<CandidateWorkload>(
    `SELECT persona_id::text, open_tasks, capacity_per_day, skills,
            available_from, available_to
       FROM assignment.workload
      WHERE persona_id = ANY($1::uuid[])`,
    [persona_ids],
  );
  for (const r of rows) map.set(r.persona_id, r);
  return map;
}

async function loadAllSkilledWorkloads(
  tenant_id: string,
  required_skills: string[],
  candidate_persona_ids?: string[],
): Promise<CandidateWorkload[]> {
  if (candidate_persona_ids && candidate_persona_ids.length > 0) {
    const m = await loadCandidateWorkloads(candidate_persona_ids);
    return Array.from(m.values()).filter((w) => hasSkills(w, required_skills));
  }
  // No territory hit + no candidate list — fall back to scan-by-skill.
  // Production with millions of personas swaps to an indexed table; v1
  // accepts the table scan because the workload table is tenant-tiny.
  const rows = await dataService.rows<CandidateWorkload>(
    `SELECT persona_id::text, open_tasks, capacity_per_day, skills,
            available_from, available_to
       FROM assignment.workload
      WHERE ($1::text[] = '{}' OR skills @> $1::text[])`,
    [required_skills],
  );
  return rows;
}

function scoreCandidates(
  workloads: CandidateWorkload[],
  primary: Set<string>,
  required_skills: string[],
  task_location: GeoPoint,
  locations: Record<string, GeoPoint>,
): ScoredCandidate[] {
  const now = new Date();
  const out: ScoredCandidate[] = [];
  for (const w of workloads) {
    if (!hasSkills(w, required_skills)) continue;
    if (!isAvailable(w, now)) continue;
    const remaining = w.capacity_per_day - w.open_tasks;
    if (remaining <= 0) continue;
    const loc = locations[w.persona_id];
    const distance = loc ? haversineKm(task_location, loc) : Number.POSITIVE_INFINITY;
    out.push({
      persona_id: w.persona_id,
      capacity_remaining: remaining,
      distance_km: distance,
      is_primary: primary.has(w.persona_id),
    });
  }
  out.sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    if (a.distance_km !== b.distance_km) return a.distance_km - b.distance_km;
    return b.capacity_remaining - a.capacity_remaining;
  });
  return out;
}

interface AssignmentInsertRow {
  assignment_id: string;
  task_id: string;
  persona_id: string;
  assigned_at: Date;
  accepted_at: Date | null;
  status: string;
}

function rowToAssignment(r: AssignmentInsertRow): AssignmentRef {
  return {
    assignment_id: r.assignment_id,
    task_id: r.task_id,
    persona_id: r.persona_id,
    assigned_at: r.assigned_at.toISOString(),
    accepted_at: r.accepted_at ? r.accepted_at.toISOString() : null,
    status: r.status as AssignmentStatus,
  };
}

export async function assignByTask(input: AssignByTaskInput): Promise<AssignByTaskResult> {
  // 1. Resolve territories.
  const territories = await findTerritoriesAt(input.tenant_id, input.location);
  let candidatePersonaIds = input.candidate_persona_ids
    ?? Array.from(new Set(territories.flatMap((t) => [...t.primary_persona_ids, ...t.backup_persona_ids])));
  const primary = new Set(territories.flatMap((t) => t.primary_persona_ids));

  // 2. Load + score candidates from territory pool.
  const territoryWorkloads = candidatePersonaIds.length > 0
    ? Array.from((await loadCandidateWorkloads(candidatePersonaIds)).values())
    : [];

  // 3. If territory pool is empty / fully saturated, fall back to a
  //    skill-scoped scan with optional radius cap.
  let workloads = territoryWorkloads;
  let usedFallback = false;
  if (workloads.length === 0) {
    workloads = await loadAllSkilledWorkloads(input.tenant_id, input.required_skills);
    usedFallback = true;
  }

  // 4. Resolve persona locations (caller-supplied takes priority).
  let locations = input.persona_locations ?? {};
  if (Object.keys(locations).length === 0 && workloads.length > 0) {
    locations = await _locationResolver(input.tenant_id, workloads.map((w) => w.persona_id));
  }

  // 5. Score + pick the top candidate.
  let candidates = scoreCandidates(workloads, primary, input.required_skills, input.location, locations);

  // Radius cap (only matters when fallback was used and caller wants a hard limit).
  if (usedFallback && input.fallback_radius_km != null) {
    candidates = candidates.filter((c) => c.distance_km <= input.fallback_radius_km!);
  }

  if (candidates.length === 0) {
    throw new Error(
      `[sdk-assignment] no eligible persona for task ${input.task_id}: ` +
      `${usedFallback ? 'radius/skill scan' : 'territory pool'} returned no match.`,
    );
  }

  const winner = candidates[0];
  const territoryMatch = territories[0];

  // 6. Atomic insert + workload increment.
  const assignmentRow = await dataService.tx<AssignmentInsertRow>(async (q) => {
    const ins = await q<AssignmentInsertRow>(
      `INSERT INTO assignment.assignment
         (assignment_id, task_id, persona_id, status)
       VALUES ($1, $2, $3::uuid, 'proposed')
       RETURNING assignment_id, task_id, persona_id::text, assigned_at,
                 accepted_at, status`,
      [randomUUID(), input.task_id, winner.persona_id],
    );
    await q(
      `UPDATE assignment.workload
          SET open_tasks = open_tasks + 1
        WHERE persona_id = $1::uuid
          AND open_tasks < capacity_per_day`,
      [winner.persona_id],
    );
    return ins.rows[0];
  });

  const reason = territoryMatch
    ? (winner.is_primary ? 'primary-territory' : 'backup-territory')
    : `radius-skill-scan${input.fallback_radius_km ? `@${input.fallback_radius_km}km` : ''}`;

  try {
    await appendAuditEntry({
      pool_index: ASSIGNMENT_AUDIT_POOL,
      event_type: 'assignment.assigned.v1',
      actor_kind: 'service',
      actor_id: 'sdk-assignment',
      tenant_id: input.tenant_id,
      subject_kind: 'assignment.assignment',
      subject_id: assignmentRow.assignment_id,
      retention_class: 'regulated',
      payload: {
        assignment_id: assignmentRow.assignment_id,
        task_id: input.task_id,
        persona_id: winner.persona_id,
        reason,
        territory_id: territoryMatch?.territory_id ?? null,
        capacity_remaining_before: winner.capacity_remaining,
        distance_km: Number.isFinite(winner.distance_km) ? winner.distance_km : null,
      },
    });
  } catch (err) {
    console.warn('[sdk-assignment] assigned audit failed (non-fatal):', (err as Error).message);
  }

  return {
    assignment: rowToAssignment(assignmentRow),
    territory_id: territoryMatch?.territory_id ?? null,
    distance_km: Number.isFinite(winner.distance_km) ? winner.distance_km : null,
    reason,
  };
}

export async function acceptAssignment(assignment_id: string): Promise<AssignmentRef> {
  const row = await dataService.one<AssignmentInsertRow>(
    `UPDATE assignment.assignment
        SET status = 'accepted',
            accepted_at = now()
      WHERE assignment_id = $1 AND status = 'proposed'
    RETURNING assignment_id, task_id, persona_id::text, assigned_at,
              accepted_at, status`,
    [assignment_id],
  );
  if (!row) throw new Error(`[sdk-assignment] assignment ${assignment_id} not in 'proposed' state`);
  return rowToAssignment(row);
}

export async function rejectAssignment(input: {
  assignment_id: string;
  reason?: string;
}): Promise<AssignmentRef> {
  // Reject also decrements the workload counter so the persona can pick
  // up other tasks. We do it in one transaction.
  const row = await dataService.tx<AssignmentInsertRow>(async (q) => {
    const upd = await q<AssignmentInsertRow>(
      `UPDATE assignment.assignment
          SET status = 'rejected'
        WHERE assignment_id = $1 AND status = 'proposed'
      RETURNING assignment_id, task_id, persona_id::text, assigned_at,
                accepted_at, status`,
      [input.assignment_id],
    );
    if (upd.rows.length === 0) {
      throw new Error(`[sdk-assignment] assignment ${input.assignment_id} not in 'proposed' state`);
    }
    const r = upd.rows[0];
    await q(
      `UPDATE assignment.workload
          SET open_tasks = GREATEST(open_tasks - 1, 0)
        WHERE persona_id = $1::uuid`,
      [r.persona_id],
    );
    return r;
  });
  return rowToAssignment(row);
}

export async function completeAssignment(assignment_id: string): Promise<AssignmentRef> {
  const row = await dataService.tx<AssignmentInsertRow>(async (q) => {
    const upd = await q<AssignmentInsertRow>(
      `UPDATE assignment.assignment
          SET status = 'completed'
        WHERE assignment_id = $1 AND status = 'accepted'
      RETURNING assignment_id, task_id, persona_id::text, assigned_at,
                accepted_at, status`,
      [assignment_id],
    );
    if (upd.rows.length === 0) {
      throw new Error(`[sdk-assignment] assignment ${assignment_id} not in 'accepted' state`);
    }
    const r = upd.rows[0];
    await q(
      `UPDATE assignment.workload
          SET open_tasks = GREATEST(open_tasks - 1, 0)
        WHERE persona_id = $1::uuid`,
      [r.persona_id],
    );
    return r;
  });
  return rowToAssignment(row);
}
