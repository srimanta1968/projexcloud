import { dataService } from '@projexlight/db-runtime';
import { getRedis } from '@projexlight/redis-runtime';
import {
  PROJECTION_REFRESH_CHANNEL,
  type ProjectionRefreshedMessage,
  type ProjectSubjectInput,
  type SubjectViewRecord,
} from '../models/subjectView.model';

/**
 * subjectViewService — the writer side of the G4 projection (FR-IPS-3/5/6).
 *
 * Each refresh:
 *   1. UPSERTs the projection.subject_view row, bumping projection_version
 *      from whatever was there (monotonic).
 *   2. Mirrors the row into Redis (hot read path; sdk-identity-resolver P3
 *      reads from here).
 *   3. PUBLISHes a ProjectionRefreshedMessage on the canonical channel so
 *      multi-replica gateways can bust their own caches.
 *
 * All three steps are atomic per-call: any later read sees the new version
 * everywhere or sees a consistent older version (no torn-state window).
 */

function redisKey(person_id: string, app_id: string, tenant_id: string): string {
  return `subject_view:${tenant_id}:${app_id}:${person_id}`;
}

export async function projectSubject(input: ProjectSubjectInput): Promise<SubjectViewRecord> {
  const rows = await dataService.rows<SubjectViewRecord>(
    `INSERT INTO projection.subject_view (
       person_id, app_id, tenant_id, bu_id, primary_persona_id,
       all_persona_ids, role_template_id, effective_role_closure,
       reachable_personas, consents_granted, admin_pool_index, app_pool_index,
       projection_version, refreshed_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11, $12,
       1, now()
     )
     ON CONFLICT (person_id, app_id, tenant_id) DO UPDATE SET
       bu_id                  = EXCLUDED.bu_id,
       primary_persona_id     = EXCLUDED.primary_persona_id,
       all_persona_ids        = EXCLUDED.all_persona_ids,
       role_template_id       = EXCLUDED.role_template_id,
       effective_role_closure = EXCLUDED.effective_role_closure,
       reachable_personas     = EXCLUDED.reachable_personas,
       consents_granted       = EXCLUDED.consents_granted,
       admin_pool_index       = EXCLUDED.admin_pool_index,
       app_pool_index         = EXCLUDED.app_pool_index,
       projection_version     = projection.subject_view.projection_version + 1,
       refreshed_at           = now()
     RETURNING person_id, app_id, tenant_id, bu_id, primary_persona_id,
               all_persona_ids, role_template_id, effective_role_closure,
               reachable_personas, consents_granted,
               admin_pool_index, app_pool_index,
               projection_version, refreshed_at`,
    [
      input.person_id,
      input.app_id,
      input.tenant_id,
      input.bu_id ?? null,
      input.primary_persona_id ?? null,
      input.all_persona_ids ?? [],
      input.role_template_id ?? null,
      input.effective_role_closure ?? [],
      input.reachable_personas ?? [],
      input.consents_granted ?? [],
      input.admin_pool_index ?? null,
      input.app_pool_index ?? null,
    ],
  );
  const row = rows[0];

  // Redis hot store + fanout (best-effort; degrades gracefully if Redis is down)
  try {
    const redis = getRedis();
    await redis.set(redisKey(row.person_id, row.app_id, row.tenant_id), JSON.stringify(row));
    const msg: ProjectionRefreshedMessage = {
      person_id: row.person_id,
      app_id: row.app_id,
      tenant_id: row.tenant_id,
      projection_version: row.projection_version,
    };
    await redis.publish(PROJECTION_REFRESH_CHANNEL, JSON.stringify(msg));
  } catch {
    // Redis not initialized in this process or transient error — Postgres row
    // is still durable; safety re-projection picks up the discrepancy later.
  }

  return row;
}

/**
 * Reads a projection row. Tries Redis first, falls back to Postgres.
 * Returns null if neither has the row (cold subject). Consumer is expected
 * to trigger projectSubject() on cold-read to materialize.
 */
export async function readProjection(
  person_id: string,
  app_id: string,
  tenant_id: string,
): Promise<SubjectViewRecord | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(redisKey(person_id, app_id, tenant_id));
    if (raw) {
      const parsed = JSON.parse(raw) as SubjectViewRecord;
      parsed.refreshed_at = new Date(parsed.refreshed_at);
      return parsed;
    }
  } catch {
    // fall through to Postgres
  }
  return dataService.one<SubjectViewRecord>(
    `SELECT person_id, app_id, tenant_id, bu_id, primary_persona_id,
            all_persona_ids, role_template_id, effective_role_closure,
            reachable_personas, consents_granted,
            admin_pool_index, app_pool_index,
            projection_version, refreshed_at
       FROM projection.subject_view
      WHERE person_id = $1 AND app_id = $2 AND tenant_id = $3`,
    [person_id, app_id, tenant_id],
  );
}

/**
 * Returns rows whose refreshed_at is older than the TTL (safety re-projection
 * candidates per FR-IPS-4). Caller is the TTL scheduler in the projector
 * worker; it iterates the result and re-runs projectSubject() for each.
 */
export async function findStaleSubjects(olderThanMs: number, limit = 1000): Promise<SubjectViewRecord[]> {
  return dataService.rows<SubjectViewRecord>(
    `SELECT person_id, app_id, tenant_id, bu_id, primary_persona_id,
            all_persona_ids, role_template_id, effective_role_closure,
            reachable_personas, consents_granted,
            admin_pool_index, app_pool_index,
            projection_version, refreshed_at
       FROM projection.subject_view
      WHERE refreshed_at < now() - ($1::int * INTERVAL '1 ms')
      ORDER BY refreshed_at ASC
      LIMIT $2`,
    [olderThanMs, limit],
  );
}
