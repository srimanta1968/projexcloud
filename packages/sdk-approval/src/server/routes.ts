import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createRouteHandler,
  decideHandler,
  getRequestHandler,
  submitRequestHandler,
} from './handlers/approvalController';

/**
 * Registers /api/approvals/* routes per P4-Operational-Billing §11.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/approvals/routes', { preHandler: requireAuth }, async (req, reply) => {
    try { await createRouteHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/approvals/requests', { preHandler: requireAuth }, async (req, reply) => {
    try { await submitRequestHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { step_id: string } }>(
    '/api/approvals/steps/:step_id/decide',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await decideHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.get<{ Params: { request_id: string } }>(
    '/api/approvals/requests/:request_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await getRequestHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );
}
