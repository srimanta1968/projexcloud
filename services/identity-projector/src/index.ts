import { dataService, initPool } from '@projexlight/db-runtime';
import { log } from '@projexlight/telemetry';
import { loadConfig } from '@projexlight/config';

/**
 * identity-projector — P1 stub for the worker that fills in P2.
 *
 * Reserves the `subject_view` projection schema and provides a minimal worker
 * loop that subscribes to identity-related events (which don't exist yet in
 * P1) and writes projected rows. In P2 the projector consumes
 * `identity.app_identity.minted.v1`, `identity.tenant_membership.changed.v1`,
 * etc. and maintains the durable subject_view for the resolver's hot reads.
 */

const POLL_INTERVAL_MS = 60_000;

async function ensureProjectionSchema(): Promise<void> {
  try {
    await dataService.query(`CREATE SCHEMA IF NOT EXISTS projection`);
    await dataService.query(`
      CREATE TABLE IF NOT EXISTS projection.subject_view (
        person_id          UUID PRIMARY KEY,
        tenant_count       INTEGER NOT NULL DEFAULT 0,
        persona_count      INTEGER NOT NULL DEFAULT 0,
        last_app_identity  TIMESTAMPTZ,
        attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
        projected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    log.info('identity-projector schema ready', { actor_kind: 'service', actor_id: 'identity-projector' });
  } catch (err) {
    log.error('identity-projector schema bootstrap failed', err);
    throw err;
  }
}

async function tick(): Promise<void> {
  // P1 stub: no events to consume yet. P2 wires Kafka consumer for
  // identity.app_identity.minted.v1 et al.
  log.info('identity-projector tick (P1 stub: no events to process)', { actor_kind: 'service', actor_id: 'identity-projector' });
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

  await ensureProjectionSchema();

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopped) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  log.info('identity-projector stopped');
}

if (require.main === module) {
  main().catch((err) => {
    log.error('identity-projector fatal', err);
    process.exit(1);
  });
}

export { ensureProjectionSchema };
