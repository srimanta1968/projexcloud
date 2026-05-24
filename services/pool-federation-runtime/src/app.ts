import Fastify, { type FastifyInstance } from 'fastify';
import { initPool } from '@projexlight/db-runtime';
import { resolveRoute, recordFailover, type RouteCache } from './router';
import {
  startFailoverOrchestrator,
  type OrchestratorHandle,
} from './failoverOrchestrator';
import type { FederationQueryClass, FederationFailoverTrigger } from '@projexlight/contracts';

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

const SANCTIONED_CLASSES: FederationQueryClass[] = [
  'resolver',
  'dsar',
  'analytics',
  'lineage',
];
const FAILOVER_TRIGGERS: FederationFailoverTrigger[] = [
  'chaos-drill',
  'production-failover',
  'operator-initiated',
];

function isSanctionedClass(s: unknown): s is FederationQueryClass {
  return typeof s === 'string' && (SANCTIONED_CLASSES as string[]).includes(s);
}

function isFailoverTrigger(s: unknown): s is FederationFailoverTrigger {
  return typeof s === 'string' && (FAILOVER_TRIGGERS as string[]).includes(s);
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

  fastify.get('/health', async () => ({
    ok: true,
    service: 'pool-federation-runtime',
    orchestrator: orchestrator.stats(),
  }));

  // P7 AC-6 — chaos drill endpoint. Operator-triggered; records a chaos-drill
  // failover_event with measured RPO/RTO so the monthly drill produces
  // auditable numbers. Auth via FEDERATION_ADMIN_TOKEN header.
  fastify.post<{
    Body: { federation_id?: string; from_region?: string; to_region?: string };
  }>('/admin/chaos-drill', async (req, reply) => {
    const token = process.env.FEDERATION_ADMIN_TOKEN;
    const presented = req.headers['x-admin-ops-token'];
    if (!token || presented !== token) {
      return reply.code(401).send({ error: 'admin token required' });
    }
    const body = req.body ?? {};
    if (!body.federation_id || !body.from_region || !body.to_region) {
      return reply.code(400).send({
        error: 'federation_id, from_region, to_region required',
      });
    }
    try {
      const event = await orchestrator.runChaosDrill({
        federation_id: body.federation_id,
        from_region: body.from_region,
        to_region: body.to_region,
      });
      return reply.code(201).send(event);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // Resolve a route. GET /routes/:federation_id/:query_class
  fastify.get<{
    Params: { federation_id: string; query_class: string };
    Querystring: { bypass_cache?: string };
  }>('/routes/:federation_id/:query_class', async (req, reply) => {
    const { federation_id, query_class } = req.params;
    if (!isSanctionedClass(query_class)) {
      return reply.code(400).send({
        error: 'invalid_query_class',
        message: `query_class must be one of ${SANCTIONED_CLASSES.join(',')}`,
      });
    }
    const bypassCache = req.query.bypass_cache === 'true';
    const ref = await resolveRoute(federation_id, query_class, {
      cache: opts.cache,
      bypassCache,
    });
    if (!ref) return reply.code(404).send({ error: 'route_not_found' });
    return ref;
  });

  // Record a failover. POST /failovers
  fastify.post<{
    Body: {
      event_id: string;
      federation_id: string;
      from_region: string;
      to_region: string;
      trigger: string;
      rpo_observed: number;
      rto_observed: number;
    };
  }>('/failovers', async (req, reply) => {
    const body = req.body;
    if (!isFailoverTrigger(body.trigger)) {
      return reply.code(400).send({
        error: 'invalid_trigger',
        message: `trigger must be one of ${FAILOVER_TRIGGERS.join(',')}`,
      });
    }
    const event = await recordFailover({
      event_id: body.event_id,
      federation_id: body.federation_id,
      from_region: body.from_region,
      to_region: body.to_region,
      trigger: body.trigger,
      rpo_observed: body.rpo_observed,
      rto_observed: body.rto_observed,
    });
    return reply.code(201).send(event);
  });

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
