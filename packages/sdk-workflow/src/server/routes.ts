import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  queryRunHandler,
  registerDefHandler,
  signalHandler,
  startRunHandler,
} from './handlers/workflowController';

/**
 * Registers /api/workflows/* routes per P4-Operational-Billing §7.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/workflows/definitions', { preHandler: requireAuth }, async (req, reply) => {
    try { await registerDefHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/workflows/start', { preHandler: requireAuth }, async (req, reply) => {
    try { await startRunHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { run_id: string } }>(
    '/api/workflows/:run_id/signal',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await signalHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/workflows/:run_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await queryRunHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );
}
