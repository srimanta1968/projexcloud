import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createTemplateHandler,
  sendHandler,
  setQuietHoursHandler,
} from './handlers/notificationController';
import {
  createEmailProviderHandler,
  listEmailProvidersHandler,
  rotateEmailProviderHandler,
  revokeEmailProviderHandler,
  verifyEmailProviderHandler,
} from './handlers/emailProviderController';

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

  // Customer-facing email provider configuration (BYO SMTP / SendGrid / SES).
  app.post('/api/notifications/providers', { preHandler: requireAuth }, async (req, reply) => {
    try { await createEmailProviderHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/notifications/providers', { preHandler: requireAuth }, async (req, reply) => {
    try { await listEmailProvidersHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.patch('/api/notifications/providers/:provider_id', { preHandler: requireAuth }, async (req, reply) => {
    try { await rotateEmailProviderHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.delete('/api/notifications/providers/:provider_id', { preHandler: requireAuth }, async (req, reply) => {
    try { await revokeEmailProviderHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/notifications/providers/:provider_id/verify', { preHandler: requireAuth }, async (req, reply) => {
    try { await verifyEmailProviderHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });
}
