import type { FastifyInstance } from 'fastify';
import { resolveRoute, recordFailover, type RouteCache } from './router';
import type { OrchestratorHandle } from './failoverOrchestrator';
import type { FederationQueryClass, FederationFailoverTrigger } from '@projexlight/contracts';

/**
 * HTTP surface for services/pool-federation-runtime (G10 closer).
 *
 * Endpoints:
 *   GET  /health                              — liveness + orchestrator stats (standalone only)
 *   POST /admin/chaos-drill                   — operator-triggered chaos drill (AC-6)
 *   GET  /routes/:federation_id/:query_class  — resolve a sanctioned cross-pool route
 *   POST /failovers                           — record a failover_event
 *
 * Extracted from buildApp so the same route plugin can be mounted both by the
 * standalone binary (:8083) and inside the api-gateway (single-target testing).
 * Runtime state (orchestrator, route cache) is threaded in via opts because
 * these handlers close over it; the gateway mount omits them (mountHealth:false,
 * no orchestrator) and the two orchestrator-backed routes degrade gracefully.
 */

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

export interface RegisterRoutesOptions {
  /**
   * Skip /health when mounted inside an aggregator (the api-gateway already
   * owns /health); the standalone binary registers it (default). Prevents
   * FST_ERR_DUPLICATED_ROUTE.
   */
  mountHealth?: boolean;
  /** Failover orchestrator — supplied by the standalone buildApp. */
  orchestrator?: OrchestratorHandle;
  /** Optional Redis-style route cache — supplied by the standalone buildApp. */
  cache?: RouteCache;
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RegisterRoutesOptions = {},
): Promise<void> {
  const { orchestrator, cache } = opts;

  if (opts.mountHealth !== false) {
    app.get('/health', async () => ({
      ok: true,
      service: 'pool-federation-runtime',
      orchestrator: orchestrator ? orchestrator.stats() : null,
    }));
  }

  // P7 AC-6 — chaos drill endpoint. Operator-triggered; records a chaos-drill
  // failover_event with measured RPO/RTO so the monthly drill produces
  // auditable numbers. Auth via FEDERATION_ADMIN_TOKEN header.
  app.post<{
    Body: { federation_id?: string; from_region?: string; to_region?: string };
  }>('/admin/chaos-drill', async (req, reply) => {
    const token = process.env.FEDERATION_ADMIN_TOKEN;
    const presented = req.headers['x-admin-ops-token'];
    if (!token || presented !== token) {
      return reply.code(401).send({ error: 'admin token required' });
    }
    if (!orchestrator) {
      // Mounted without an orchestrator (e.g. inside the api-gateway, which runs
      // its own federation orchestrator on /admin/federation/*). No-op here.
      return reply.code(503).send({ error: 'orchestrator not available in this deployment' });
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
  app.get<{
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
      cache,
      bypassCache,
    });
    if (!ref) return reply.code(404).send({ error: 'route_not_found' });
    return ref;
  });

  // Record a failover. POST /failovers
  app.post<{
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
}
