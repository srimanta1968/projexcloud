import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createTemplateHandler,
  sendHandler,
  setQuietHoursHandler,
} from './handlers/notificationController';

/**
 * Registers /api/notifications/* routes per P4-Operational-Billing §5.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/notifications/send', { preHandler: requireAuth }, async (req, reply) => {
    try { await sendHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/notifications/templates', { preHandler: requireAuth }, async (req, reply) => {
    try { await createTemplateHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/notifications/quiet-hours', { preHandler: requireAuth }, async (req, reply) => {
    try { await setQuietHoursHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });
}
