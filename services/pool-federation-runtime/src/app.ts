import Fastify, { type FastifyInstance } from 'fastify';
import { initPool } from '@projexlight/db-runtime';
import { type RouteCache } from './router';
import {
  startFailoverOrchestrator,
  type OrchestratorHandle,
} from './failoverOrchestrator';
import { registerRoutes } from './routes';

/**
 * services/pool-federation-runtime — HTTP surface for the G10 closer.
 *
 * Boots:
 *   - Postgres pool (POOL_FEDERATION_DB_URL → ProjexCloud admin DB).
 *   - Fastify on PORT (default 8083) with /health + /routes endpoints.
 *
 * Replicas are stateless — every routing decision reads from
 * federation.route with an optional Redis cache. Failover orchestration
 * is owned by an operator-driven endpoint (POST /failovers) for now;
 * automatic Tier-G failover lands in follow-up tasks.
 */

export interface AppOptions {
  databaseUrl?: string;
  cache?: RouteCache;
}

export interface BuiltApp {
  fastify: FastifyInstance;
  orchestrator: OrchestratorHandle;
}

export async function buildApp(opts: AppOptions = {}): Promise<BuiltApp> {
  const databaseUrl = opts.databaseUrl
    ?? process.env.POOL_FEDERATION_DB_URL
    ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      '[pool-federation-runtime] no database URL configured. Set POOL_FEDERATION_DB_URL or DATABASE_URL.',
    );
  }
  initPool({ connectionString: databaseUrl });

  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
  });

  // P7 FR-FED-3 — auto-failover orchestrator. Default polling 10s; threshold
  // 3 failed probes. Disabled with FEDERATION_FAILOVER_ENABLED=false.
  const orchestrator = startFailoverOrchestrator({
    enabled: process.env.FEDERATION_FAILOVER_ENABLED !== 'false',
    intervalMs: parseInt(process.env.FEDERATION_PROBE_INTERVAL_MS ?? '10000', 10),
    failureThreshold: parseInt(process.env.FEDERATION_FAILURE_THRESHOLD ?? '3', 10),
  });

  // HTTP surface lives in ./routes so the api-gateway can mount the same plugin
  // (single-target testing). The standalone binary registers /health + all
  // endpoints and threads in the orchestrator + route cache.
  await registerRoutes(fastify, { orchestrator, cache: opts.cache });

  fastify.addHook('onClose', async () => {
    await orchestrator.stop();
  });

  return { fastify, orchestrator };
}

/** Process-level entry — wires SIGTERM/SIGINT to graceful shutdown. */
export async function main(): Promise<void> {
  const { fastify } = await buildApp();
  const port = parseInt(process.env.PORT ?? '8083', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await fastify.listen({ port, host });
  console.log(`[pool-federation-runtime] listening on ${host}:${port}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[pool-federation-runtime] received ${sig}; shutting down`);
    try { await fastify.close(); } catch (err) { console.error(err); }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
