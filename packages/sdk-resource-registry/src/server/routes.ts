import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { getOwnership, registerResource } from '../services/resourceRegistryService';
import type { RegisterResourceInput } from '../models/resourceRegistry.model';

/**
 * Registers /api/resources/* routes (P10/E5). Thin read API surfacing
 * ownership to the admin app, plus a register endpoint for GitOps sync.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/resources/:resource_id — ownership lookup for the admin app.
  app.get<{ Params: { resource_id: string } }>(
    '/api/resources/:resource_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const record = await getOwnership(req.params.resource_id);
        if (!record) {
          return reply.code(404).send({ error: 'NotFound', details: [`No registry row for ${req.params.resource_id}`] });
        }
        return reply.code(200).send({ data: { resource: record } });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  // POST /api/resources — register/update an owned resource (GitOps sync).
  app.post<{ Body: Partial<RegisterResourceInput> }>(
    '/api/resources',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.resource_id || !b.resource_type || !b.environment || !b.owner || !b.approved_by) {
        return reply.code(400).send({
          error: 'ValidationError',
          details: ['resource_id, resource_type, environment, owner, approved_by are required'],
        });
      }
      try {
        const resource = await registerResource(b as RegisterResourceInput);
        return reply.code(201).send({ data: { resource } });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError', details: [(err as Error).message] });
      }
    },
  );
}
