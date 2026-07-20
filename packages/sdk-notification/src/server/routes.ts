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
import {
  processInboundSms,
  verifyInboundSmsSignature,
  upsertSmsSettings,
  listInboundSms,
  propagateSmsConsent,
  listSmsConsent,
} from '../services/smsInboundService';
import {
  processDeliveryCallback,
  listDeliveryReceipts,
} from '../services/deliveryCallbackService';

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

  /* -------------------------------- inbound SMS + STOP/HELP/START (TK-3634) */
  // Configure a tenant's inbound-SMS settings (signing secret + auto-reply text).
  app.post('/api/notifications/sms-settings', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; signing_secret: string; help_reply: string; opt_out_reply: string; opt_in_reply: string }>;
    if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    const settings = await upsertSmsSettings({
      tenantId: body.tenant_id, signingSecret: body.signing_secret, helpReply: body.help_reply,
      optOutReply: body.opt_out_reply, optInReply: body.opt_in_reply,
    });
    return reply.code(201).send({ data: { settings: { tenant_id: settings.tenant_id, help_reply: settings.help_reply } } });
  });

  // PUBLIC inbound SMS webhook (Twilio). HMAC-verified when a signing secret is
  // configured, else accepted. Classifies STOP/START/HELP (case-insensitive) and routes
  // the intent to the consent pipeline; HELP returns the configured auto-reply. tenant_id
  // is carried on the per-tenant webhook URL via ?tenant_id=. Idempotent per message SID.
  app.post<{ Querystring: { tenant_id?: string } }>(
    '/api/notifications/webhooks/sms/inbound', async (req, reply) => {
      const tenantId = req.query.tenant_id;
      if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const b = (req.body ?? {}) as Record<string, string>;
      const from = b.From ?? b.from;
      if (!from) return reply.code(400).send({ error: 'ValidationError', details: ['From is required'] });
      const rawBody = JSON.stringify(req.body ?? {});
      const signature = (req.headers['x-twilio-signature'] ?? req.headers['x-webhook-signature']) as string | undefined;
      const { verified, enforced } = await verifyInboundSmsSignature(tenantId, rawBody, signature);
      if (enforced && !verified) {
        return reply.code(401).send({ error: 'InvalidSignature', details: ['inbound SMS signature verification failed'] });
      }
      const result = await processInboundSms({
        tenantId, provider: 'twilio', fromNumber: from, toNumber: b.To ?? b.to,
        body: b.Body ?? b.body, messageSid: b.MessageSid ?? b.message_sid, signatureVerified: verified,
      });
      return reply.code(200).send({ data: result });
    },
  );

  // List a tenant's inbound SMS (optionally by keyword intent).
  app.get<{ Querystring: { tenant_id?: string; intent?: string; limit?: string } }>(
    '/api/notifications/sms-inbound', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const messages = await listInboundSms(req.query.tenant_id, {
        intent: req.query.intent, limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { messages } });
    },
  );

  /* ------------------------- SMS opt-out propagation to consent (TK-3635) */
  // Propagate an SMS opt-out/opt-in to suppression + consent + event (idempotent, PII-safe).
  app.post('/api/notifications/sms-consent', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; phone: string; action: 'opt_out' | 'opt_in'; source: string; purpose: string }>;
    if (!body.tenant_id || !body.phone || !body.action) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, phone and action are required'] });
    }
    if (body.action !== 'opt_out' && body.action !== 'opt_in') {
      return reply.code(400).send({ error: 'ValidationError', details: ['action must be opt_out or opt_in'] });
    }
    const result = await propagateSmsConsent({
      tenantId: body.tenant_id, phone: body.phone, action: body.action, source: body.source ?? 'api', purpose: body.purpose,
    });
    return reply.code(200).send({ data: { consent: result } });
  });

  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string } }>(
    '/api/notifications/sms-consent', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const consents = await listSmsConsent(req.query.tenant_id, {
        status: req.query.status, limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { consents } });
    },
  );

  /* ---------------------------- delivery-status callbacks (TK-3636) */
  // PUBLIC delivery-status webhook (Twilio/SES/SendGrid). Normalizes the status, maps it
  // to markDelivered by provider_message_id (sent->delivered fires once), records an
  // idempotent receipt, and feeds reputation. Unknown ids handled gracefully. tenant_id
  // via ?tenant_id=. Signature-verified when a per-tenant secret is configured.
  app.post<{ Params: { provider: string }; Querystring: { tenant_id?: string } }>(
    '/api/notifications/webhooks/delivery/:provider', async (req, reply) => {
      const tenantId = req.query.tenant_id;
      if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const provider = String(req.params.provider).toLowerCase();
      const rawBody = JSON.stringify(req.body ?? {});
      const signature = (req.headers['x-twilio-signature'] ?? req.headers['x-webhook-signature'] ?? req.headers['signature']) as string | undefined;
      const { verified, enforced } = await verifyInboundSmsSignature(tenantId, rawBody, signature);
      if (enforced && !verified) {
        return reply.code(401).send({ error: 'InvalidSignature', details: ['delivery callback signature verification failed'] });
      }
      const result = await processDeliveryCallback({ tenantId, provider, payload: req.body, signatureVerified: verified });
      return reply.code(200).send({ data: result });
    },
  );

  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string } }>(
    '/api/notifications/delivery-receipts', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const receipts = await listDeliveryReceipts(req.query.tenant_id, {
        status: req.query.status, limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { receipts } });
    },
  );
}
