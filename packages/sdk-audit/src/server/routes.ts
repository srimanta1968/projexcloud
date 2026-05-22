import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendHandler } from './handlers/auditController';
import { verifyHandler } from './handlers/verifyController';
import { exportHandler } from './handlers/exportController';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * Registers /api/audit/* routes per P1-Foundation-Spine §7. All routes
 * require a valid JWT (auth middleware comes from sdk-identity).
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/audit/append', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await appendHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/audit/verify', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await verifyHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Body: Record<string, unknown> }>('/api/audit/export', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await exportHandler(req as never, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
