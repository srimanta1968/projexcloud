import Fastify, { type FastifyInstance } from 'fastify';
import { initPool } from '@projexlight/db-runtime';
import { startProjectorWorker, type ProjectorHandle } from './worker';

/**
 * services/lineage-projector — HTTP + worker process.
 *
 * Boots:
 *   - Postgres pool (LINEAGE_PROJECTOR_DB_URL → ProjexCloud admin DB).
 *   - Projector worker (drains queue → Iceberg writer).
 *   - Fastify /health endpoint with current worker stats.
 *
 * Designed to run as N replicas; SELECT FOR UPDATE SKIP LOCKED in
 * sdk-lineage makes the queue draining safe under concurrency.
 */

export interface AppOptions {
  databaseUrl?: string;
}

export interface BuiltApp {
  fastify: FastifyInstance;
  projector: ProjectorHandle;
}

export async function buildApp(opts: AppOptions = {}): Promise<BuiltApp> {
  const databaseUrl = opts.databaseUrl
    ?? process.env.LINEAGE_PROJECTOR_DB_URL
    ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      '[lineage-projector] no database URL configured. Set LINEAGE_PROJECTOR_DB_URL or DATABASE_URL.',
    );
  }
  initPool({ connectionString: databaseUrl });

  const projector = startProjectorWorker();

  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
  });

  fastify.get('/health', async () => {
    const s = projector.stats();
    return {
      ok: true,
      service: 'lineage-projector',
      stats: s,
    };
  });

  fastify.get('/metrics', async () => projector.stats());

  fastify.addHook('onClose', async () => {
    await projector.stop();
  });

  return { fastify, projector };
}

/** Process-level entry — wires SIGTERM/SIGINT to graceful shutdown. */
export async function main(): Promise<void> {
  const { fastify } = await buildApp();
  const port = parseInt(process.env.PORT ?? '8081', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await fastify.listen({ port, host });
  console.log(`[lineage-projector] listening on ${host}:${port}`);

  const shutdown = async (sig: string) => {
    console.log(`[lineage-projector] received ${sig}; shutting down`);
    try { await fastify.close(); } catch (err) { console.error(err); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
