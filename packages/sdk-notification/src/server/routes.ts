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
import { unifiedDispatch } from '../services/dispatchService';
import type { NotificationChannel } from '../models/notification.model';

const DISPATCH_CHANNELS: NotificationChannel[] = ['email', 'sms', 'whatsapp', 'push', 'slack'];

/**
 * Registers /api/notifications/* routes per P4-Operational-Billing §5.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/notifications/send', { preHandler: requireAuth }, async (req, reply) => {
    try { await sendHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  // Unified channel-routing transport (P14·E4, TK-3631): routes a message to the
  // channel's provider chain with failover (email SES/SMTP, SMS Twilio), deferring on
  // per-persona quiet hours. The same transport backs the sdk-sequence step sender.
  app.post('/api/notifications/dispatch', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; channel: NotificationChannel; destination: string; body: string;
      subject: string; subject_persona_id: string; respect_quiet_hours: boolean; metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.channel || !body.destination || !body.body) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel, destination and body are required'] });
    }
    if (!DISPATCH_CHANNELS.includes(body.channel)) {
      return reply.code(400).send({ error: 'ValidationError', details: [`channel must be one of ${DISPATCH_CHANNELS.join(', ')}`] });
    }
    const result = await unifiedDispatch({
      tenant_id: body.tenant_id, channel: body.channel, destination: body.destination, body: body.body,
      subject: body.subject, subject_persona_id: body.subject_persona_id,
      respect_quiet_hours: body.respect_quiet_hours, metadata: body.metadata,
    });
    return reply.code(200).send({ data: { dispatch: result } });
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
