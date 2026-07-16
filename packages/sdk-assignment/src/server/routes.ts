import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { assignByTask, type AssignByTaskInput, type AssignStrategy } from '../services/assignmentEngine';
import type { GeoPoint } from '../services/geofence';

const STRATEGIES: AssignStrategy[] = ['default', 'round_robin', 'fair_share'];

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
}
