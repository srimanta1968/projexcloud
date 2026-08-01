import { FastifyInstance } from 'fastify';
import { requireAuthOrApiKeyForDomain } from '@projexlight/sdk-api-keys';

/**
 * Every route in this SDK accepts EITHER a six-layer JWT or a tenant-scoped
 * `pk_live_`/`pk_test_` API key. Machine callers (vertical apps calling the
 * platform server-to-server) previously had no way to authenticate here, and the
 * only workaround was to put a human's password in a service's environment.
 *
 * Key holders must carry the scope derived from the route: `assignment.<resource>.read`
 * for GET, `assignment.<resource>.write` otherwise, where <resource> is the path
 * segment after `assignment` (so POST /api/assignment/... maps predictably). JWT
 * callers are unaffected — scopes apply only to keys.
 *
 * Named `requireAuth` so the route definitions below read unchanged; it is the
 * combined guard, not sdk-identity's JWT-only one.
 */
const requireAuth = requireAuthOrApiKeyForDomain('assignment');
import { assignByTask, type AssignByTaskInput, type AssignStrategy } from '../services/assignmentEngine';
import { setWorkload } from '../services/workloadService';
import type { GeoPoint } from '../services/geofence';

const STRATEGIES: AssignStrategy[] = ['default', 'round_robin', 'fair_share'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HTTP surface for sdk-assignment (EP-335). Exposes the auto-assignment engine
 * so sdk-scheduling and lead routing consume one implementation rather than
 * duplicating the strategy selection. Tenant-scoped; every call requires auth.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/assignment/assign-by-task', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      task_id: string;
      tenant_id: string;
      location: GeoPoint;
      required_skills: string[];
      fallback_radius_km: number;
      persona_locations: Record<string, GeoPoint>;
      candidate_persona_ids: string[];
      strategy: AssignStrategy;
      pool_key: string;
    }>;

    if (!body.task_id || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['task_id and tenant_id are required'] });
    }
    if (!body.location || typeof body.location.lat !== 'number' || typeof body.location.lng !== 'number') {
      return reply.code(400).send({ error: 'ValidationError', details: ['location {lat,lng} is required'] });
    }
    if (body.strategy && !STRATEGIES.includes(body.strategy)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid strategy'] });
    }

    const input: AssignByTaskInput = {
      task_id: body.task_id,
      tenant_id: body.tenant_id,
      location: body.location,
      required_skills: body.required_skills ?? [],
      fallback_radius_km: body.fallback_radius_km,
      persona_locations: body.persona_locations,
      candidate_persona_ids: body.candidate_persona_ids,
      strategy: body.strategy,
      pool_key: body.pool_key,
    };

    try {
      const result = await assignByTask(input);
      return reply.code(201).send({ data: result });
    } catch (err) {
      // No eligible persona (empty pool / all at capacity) is a 409 — the task
      // stays queued for a later dispatcher pass, not a client input error.
      return reply.code(409).send({ error: 'NoEligiblePersona', message: (err as Error).message });
    }
  });

  // FR-ASN-3 workload upsert — the HTTP surface for the existing setWorkload
  // service. Lets dispatchers (and tests) provision a persona's capacity/skills/
  // availability via the API instead of a direct DB seed. Idempotent on
  // persona_id; open_tasks is dispatcher-owned and deliberately not settable.
  app.put<{
    Params: { persona_id: string };
    Body: Partial<{
      capacity_per_day: number;
      skills: string[];
      available_from: string;
      available_to: string;
    }>;
  }>('/api/assignment/workload/:persona_id', { preHandler: requireAuth }, async (req, reply) => {
    const { persona_id } = req.params;
    if (!persona_id || !UUID_RE.test(persona_id)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['persona_id must be a UUID'] });
    }
    const body = req.body ?? {};
    try {
      const result = await setWorkload({
        persona_id,
        capacity_per_day: body.capacity_per_day,
        skills: body.skills,
        available_from: body.available_from ? new Date(body.available_from) : null,
        available_to: body.available_to ? new Date(body.available_to) : null,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return reply.code(500).send({ error: 'InternalError', message: (err as Error).message });
    }
  });
}
