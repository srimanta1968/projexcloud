import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createTenantHandler, getTenantHandler } from './handlers/tenantController';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * Registers /api/tenants/* routes per P2-Identity-Access §4.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tenants', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await createTenantHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.get<{ Params: { tenant_id: string } }>('/api/tenants/:tenant_id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await getTenantHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
