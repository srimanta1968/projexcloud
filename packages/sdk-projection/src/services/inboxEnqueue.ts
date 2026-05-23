import { dataService } from '@projexlight/db-runtime';

/**
 * FR-IPS-2 producer-side hook. Any SDK service that mutates state which
 * affects the projection (identity.persona / tenant_membership / rebac.
 * relationship / consent.receipt / tenant.bu / tenant.role_template) calls
 * enqueueProjectionRefresh() with the affected (person, app, tenant) tuples.
 *
 * The projector worker drains projection._inbox every EVENT_POLL_INTERVAL_MS
 * (default 5s) and runs reprojectOne() per row. End-to-end refresh latency
 * stays well under the AC-14 1s p99 target as long as the worker isn't
 * starved by the TTL sweep.
 *
 * Best-effort: writes go through DataService (OC-3); failures are logged but
 * never re-raised so the calling service's hot path is unaffected.
 */
export interface ProjectionTouchInput {
  person_id: string;
  /** Optional — when omitted the caller wants every (app, tenant) row for the
   * person re-projected. Implemented as an enqueue per active membership. */
  app_id?: string;
  tenant_id?: string;
}

export async function enqueueProjectionRefresh(input: ProjectionTouchInput): Promise<void> {
  try {
    if (input.app_id && input.tenant_id) {
      await dataService.query(
        `INSERT INTO projection._inbox (person_id, app_id, tenant_id) VALUES ($1, $2, $3)`,
        [input.person_id, input.app_id, input.tenant_id],
      );
      return;
    }
    // Fan-out: enqueue one row per active (app, tenant) membership for the
    // person. Cheap — typical person has < 10 memberships.
    await dataService.query(
      `INSERT INTO projection._inbox (person_id, app_id, tenant_id)
       SELECT $1, t.app_id, m.tenant_id
         FROM identity.tenant_membership m
         JOIN tenant.tenant t ON t.tenant_id = m.tenant_id
        WHERE m.person_id = $1 AND m.status = 'active'`,
      [input.person_id],
    );
  } catch (err) {
    console.warn(
      `[projection.enqueue] failed person=${input.person_id}:`,
      (err as Error).message,
    );
  }
}

/**
 * Enqueue every active subject in a tenant — used when tenant-wide config
 * changes (role-template update, BU move, fiscal calendar reset) require
 * the whole tenant to re-project.
 */
export async function enqueueTenantRefresh(tenant_id: string): Promise<void> {
  try {
    await dataService.query(
      `INSERT INTO projection._inbox (person_id, app_id, tenant_id)
       SELECT m.person_id, t.app_id, m.tenant_id
         FROM identity.tenant_membership m
         JOIN tenant.tenant t ON t.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.status = 'active'`,
      [tenant_id],
    );
  } catch (err) {
    console.warn(
      `[projection.enqueueTenant] failed tenant=${tenant_id}:`,
      (err as Error).message,
    );
  }
}
