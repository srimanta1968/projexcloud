import { dataService } from '@projexlight/db-runtime';
import type { WorkloadRef } from '@projexlight/contracts';

/**
 * Workload CRUD (FR-ASN-3).
 *
 * One row per persona — keeps the dispatcher's per-persona capacity,
 * skill set, and availability window. `open_tasks` is incremented in
 * the same transaction that creates an assignment.assignment row so the
 * capacity check can't race.
 */

interface WorkloadRow {
  persona_id: string;
  open_tasks: number;
  capacity_per_day: number;
  skills: string[];
  available_from: Date | null;
  available_to: Date | null;
}

function rowToRef(r: WorkloadRow): WorkloadRef {
  return {
    persona_id: r.persona_id,
    open_tasks: r.open_tasks,
    capacity_per_day: r.capacity_per_day,
    skills: r.skills,
    available_from: r.available_from ? r.available_from.toISOString() : null,
    available_to: r.available_to ? r.available_to.toISOString() : null,
  };
}

export interface SetWorkloadInput {
  persona_id: string;
  capacity_per_day?: number;
  skills?: string[];
  available_from?: Date | null;
  available_to?: Date | null;
}

/**
 * Upsert a persona's workload profile. Idempotent on persona_id. Does
 * NOT touch open_tasks — that field is mutated only by the assignment
 * engine inside its transaction.
 */
export async function setWorkload(input: SetWorkloadInput): Promise<WorkloadRef> {
  const row = await dataService.one<WorkloadRow>(
    `INSERT INTO assignment.workload
       (persona_id, capacity_per_day, skills, available_from, available_to)
     VALUES ($1::uuid, $2, $3, $4, $5)
     ON CONFLICT (persona_id) DO UPDATE
       SET capacity_per_day = COALESCE($2, assignment.workload.capacity_per_day),
           skills = COALESCE($3, assignment.workload.skills),
           available_from = $4,
           available_to = $5
     RETURNING persona_id::text, open_tasks, capacity_per_day, skills,
               available_from, available_to`,
    [
      input.persona_id,
      input.capacity_per_day ?? null,
      input.skills ?? null,
      input.available_from ?? null,
      input.available_to ?? null,
    ],
  );
  if (!row) throw new Error('[sdk-assignment] setWorkload upsert failed');
  return rowToRef(row);
}

export async function getWorkload(persona_id: string): Promise<WorkloadRef | null> {
  const row = await dataService.one<WorkloadRow>(
    `SELECT persona_id::text, open_tasks, capacity_per_day, skills,
            available_from, available_to
       FROM assignment.workload WHERE persona_id = $1::uuid`,
    [persona_id],
  );
  return row ? rowToRef(row) : null;
}

export async function listWorkloads(persona_ids: string[]): Promise<WorkloadRef[]> {
  if (persona_ids.length === 0) return [];
  const rows = await dataService.rows<WorkloadRow>(
    `SELECT persona_id::text, open_tasks, capacity_per_day, skills,
            available_from, available_to
       FROM assignment.workload
      WHERE persona_id = ANY($1::uuid[])`,
    [persona_ids],
  );
  return rows.map(rowToRef);
}
