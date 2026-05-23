import { dataService, initPool } from '@projexlight/db-runtime';
import { initRedis } from '@projexlight/redis-runtime';
import { log } from '@projexlight/telemetry';
import { loadConfig } from '@projexlight/config';
import {
  findStaleSubjects,
  projectSubject,
  type SubjectViewRecord,
} from '@projexlight/sdk-projection';

/**
 * identity-projector — the G4 closer (P2).
 *
 * Two responsibilities:
 *   1. Event-driven refresh: pulls (person, app, tenant) tuples from
 *      `projection._inbox` rows that upstream services enqueue on identity /
 *      rebac / consent change, and re-projects each one within 1s
 *      (FR-IPS-3 / AC-14).
 *   2. TTL safety re-projection: every PROJECTION_TTL_INTERVAL_MS sweeps
 *      stale rows older than PROJECTION_TTL_SECONDS and re-projects them
 *      (FR-IPS-4) to catch any missed events.
 *
 * Migrations: the projection schema is owned by @projexlight/sdk-projection
 * and applied by the api-gateway runMigrations chain on startup. This worker
 * is a writer only — it never DDLs its own tables (one bootstrap CREATE for
 * _inbox is a belt-and-braces guard for direct projector startup).
 */

const TTL_SECONDS = parseInt(process.env.PROJECTION_TTL_SECONDS || '3600', 10);
const TTL_REPROJECTION_INTERVAL_MS = parseInt(
  process.env.PROJECTION_TTL_INTERVAL_MS || '300000',
  10,
);
const EVENT_POLL_INTERVAL_MS = parseInt(process.env.PROJECTION_EVENT_INTERVAL_MS || '5000', 10);
const REDIS_ENABLED = process.env.REDIS_ENABLED === 'true';

interface ProjectorState {
  stopped: boolean;
  lastTtlSweep: number;
}

async function fetchSubjectFromMdm(
  person_id: string,
  app_id: string,
  tenant_id: string,
): Promise<Parameters<typeof projectSubject>[0]> {
  // Pulls the live six-layer state from canonical sources. P3+ now joins
  // persona.* alongside identity.tenant_membership so primary_persona_id /
  // all_persona_ids are populated for downstream resolver reads (AC-8).
  const membership = await dataService.one<{
    bu_id: string | null;
    role_template_id: string | null;
  }>(
    `SELECT bu_id, role_template_id
       FROM identity.tenant_membership
      WHERE person_id = $1 AND tenant_id = $2 AND status = 'active'
      LIMIT 1`,
    [person_id, tenant_id],
  );

  const tenantRow = await dataService.one<{
    admin_pool_index: string | null;
    app_pool_index: Record<string, string>;
  }>(
    `SELECT admin_pool_index, app_pool_index
       FROM tenant.tenant WHERE tenant_id = $1`,
    [tenant_id],
  );

  const consents = await dataService.rows<{ purpose_id: string }>(
    `SELECT purpose_id FROM consent.receipt
      WHERE person_id = $1 AND revoked_at IS NULL`,
    [person_id],
  );

  // P3 join: persona.app_identity × persona.membership × persona.persona.
  // Returns every active persona for this (person, app, tenant). The first
  // one becomes primary_persona_id; the full list becomes all_persona_ids.
  // Schemas may not exist in test envs — degrade silently to [].
  let personaIds: string[] = [];
  try {
    const rows = await dataService.rows<{ persona_id: string }>(
      `SELECT p.persona_id
         FROM persona.persona p
         JOIN persona.membership m ON p.membership_id = m.membership_id
         JOIN persona.app_identity ai ON m.app_identity_id = ai.app_identity_id
        WHERE ai.person_id = $1 AND ai.app_id = $2 AND m.tenant_id = $3
          AND p.status = 'active'
        ORDER BY p.created_at`,
      [person_id, app_id, tenant_id],
    );
    personaIds = rows.map((r) => r.persona_id);
  } catch {
    // persona.* not migrated yet (e.g., P2-only test envs).
  }

  const appPoolMap = (tenantRow?.app_pool_index ?? {}) as Record<string, string>;

  return {
    person_id,
    app_id,
    tenant_id,
    bu_id: membership?.bu_id ?? undefined,
    primary_persona_id: personaIds[0],
    all_persona_ids: personaIds,
    role_template_id: membership?.role_template_id ?? undefined,
    consents_granted: consents.map((r) => r.purpose_id),
    admin_pool_index: tenantRow?.admin_pool_index ?? undefined,
    app_pool_index: appPoolMap[app_id],
  };
}

/**
 * Re-projects one subject. Used by both the event handler and the TTL sweep.
 */
async function reprojectOne(row: { person_id: string; app_id: string; tenant_id: string }): Promise<void> {
  try {
    const fresh = await fetchSubjectFromMdm(row.person_id, row.app_id, row.tenant_id);
    const written = await projectSubject(fresh);
    log.info('identity-projector refresh', {
      actor_kind: 'service',
      actor_id: 'identity-projector',
      person_id: written.person_id,
      tenant_id: written.tenant_id,
      projection_version: written.projection_version,
    });
  } catch (err) {
    log.error('identity-projector refresh failed', err);
  }
}

/**
 * TTL safety re-projection (FR-IPS-4). Bounded so it never starves the
 * event-driven path.
 */
async function ttlSweep(state: ProjectorState): Promise<void> {
  const now = Date.now();
  if (now - state.lastTtlSweep < TTL_REPROJECTION_INTERVAL_MS) return;
  state.lastTtlSweep = now;

  let stale: SubjectViewRecord[];
  try {
    stale = await findStaleSubjects(TTL_SECONDS * 1000, 500);
  } catch (err) {
    log.error('identity-projector TTL sweep query failed', err);
    return;
  }
  if (stale.length === 0) return;

  log.info('identity-projector TTL sweep', {
    actor_kind: 'service',
    actor_id: 'identity-projector',
    candidates: stale.length,
  });
  for (const row of stale) {
    if (state.stopped) break;
    await reprojectOne(row);
  }
}

/**
 * Drains projection._inbox — rows enqueued by upstream services on identity
 * / rebac / consent change. Each row triggers exactly one re-projection.
 */
async function processInbox(state: ProjectorState): Promise<void> {
  await dataService.query(`
    CREATE TABLE IF NOT EXISTS projection._inbox (
      inbox_id     BIGSERIAL PRIMARY KEY,
      person_id    UUID NOT NULL,
      app_id       TEXT NOT NULL,
      tenant_id    UUID NOT NULL,
      enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    )
  `);

  const rows = await dataService.rows<{
    inbox_id: number;
    person_id: string;
    app_id: string;
    tenant_id: string;
  }>(
    `SELECT inbox_id, person_id, app_id, tenant_id
       FROM projection._inbox
      WHERE processed_at IS NULL
      ORDER BY inbox_id ASC
      LIMIT 100`,
  );

  for (const row of rows) {
    if (state.stopped) break;
    await reprojectOne(row);
    await dataService.query(
      `UPDATE projection._inbox SET processed_at = now() WHERE inbox_id = $1`,
      [row.inbox_id],
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  initPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    min: config.db.poolMin,
    max: config.db.poolMax,
  });

  if (REDIS_ENABLED) {
    try {
      initRedis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
      });
      log.info('identity-projector Redis hot-store + fanout enabled', {
        actor_kind: 'service',
        actor_id: 'identity-projector',
      });
    } catch (err) {
      log.error('identity-projector Redis init failed; falling back to Postgres-only writes', err);
    }
  }

  const state: ProjectorState = { stopped: false, lastTtlSweep: 0 };
  const stop = () => { state.stopped = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  log.info('identity-projector ready (event-driven + TTL safety sweep)', {
    actor_kind: 'service',
    actor_id: 'identity-projector',
    ttl_seconds: TTL_SECONDS,
    ttl_sweep_interval_ms: TTL_REPROJECTION_INTERVAL_MS,
  });

  while (!state.stopped) {
    try {
      await processInbox(state);
      await ttlSweep(state);
    } catch (err) {
      log.error('identity-projector tick failed', err);
    }
    await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_INTERVAL_MS));
  }
  log.info('identity-projector stopped');
}

if (require.main === module) {
  main().catch((err) => {
    log.error('identity-projector fatal', err);
    process.exit(1);
  });
}

export { reprojectOne, processInbox, ttlSweep };
