import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  listDeliveriesHandler,
  publishHandler,
  registerEndpointHandler,
  replayHandler,
  subscribeHandler,
} from './handlers/webhookController';

/**
 * Registers /api/webhooks/* routes per P4-Operational-Billing §10.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/endpoints', { preHandler: requireAuth }, async (req, reply) => {
    try { await registerEndpointHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { endpoint_id: string } }>(
    '/api/webhooks/endpoints/:endpoint_id/subscribe',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await subscribeHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.post('/api/webhooks/publish', { preHandler: requireAuth }, async (req, reply) => {
    try { await publishHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/webhooks/deliveries', { preHandler: requireAuth }, async (req, reply) => {
    try { await listDeliveriesHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { delivery_id: string } }>(
    '/api/webhooks/deliveries/:delivery_id/replay',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await replayHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );
}
