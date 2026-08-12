import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuthOrApiKeyForDomain } from '@projexlight/sdk-api-keys';

/**
 * Every route in this SDK accepts EITHER a six-layer JWT or a tenant-scoped
 * `pk_live_`/`pk_test_` API key. Machine callers (vertical apps calling the
 * platform server-to-server) previously had no way to authenticate here, and the
 * only workaround was to put a human's password in a service's environment.
 *
 * Key holders must carry the scope derived from the route: `notification.<resource>.read`
 * for GET, `notification.<resource>.write` otherwise, where <resource> is the path
 * segment after `notification` (so POST /api/notification/... maps predictably). JWT
 * callers are unaffected — scopes apply only to keys.
 *
 * Named `requireAuth` so the route definitions below read unchanged; it is the
 * combined guard, not sdk-identity's JWT-only one.
 */
const requireAuth = requireAuthOrApiKeyForDomain('notification');
import { checkProviderConfigured } from '@projexlight/sdk-config';
import {
  bulkItemError,
  bulkResponse,
  parseBulkEnvelope,
  type BulkItemResult,
} from '@projexlight/contracts';
import { setFrequencyPolicy, listFrequencyPolicies, getSendUsage } from '../services/frequencyCap';
import {
  sendToAudience,
  AudienceAuthorizationError,
  type SendToAudienceInput,
} from '../services/audienceDispatch';
import {
  checkSendWindow,
  checkSendWindowBulk,
  type BulkSendWindowQuery,
  type SendWindowQuery,
  type SendWindowVerdict,
} from '../services/sendWindow';
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
 * Recipient ceiling for one audience send. Exceeding it is a 400 naming the
 * ceiling — never a truncated send, which would report success for people who
 * were never contacted.
 */
const MAX_AUDIENCE = Number(process.env.NOTIFICATION_MAX_AUDIENCE || 50000);

/** Config-resolution context from the caller's JWT (set by requireAuth). */
function ctxFrom(req: FastifyRequest): { tenant_id?: string | null; app_id?: string | null; app_user_id?: string | null } {
  const a = (req as unknown as { auth?: { sub?: string; tenant_id?: string | null; app_id?: string | null } }).auth ?? {};
  return { tenant_id: a.tenant_id ?? null, app_id: a.app_id ?? null, app_user_id: a.sub ?? null };
}

/**
 * Registers /api/notifications/* routes per P4-Operational-Billing §5.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /*
   * Send by REFERENCE (P17). Names an audience, never a destination — and the
   * response reports status per persona_id, never the address used. See
   * audienceDispatch.ts for why no address may cross this boundary in either
   * direction, and for the monotonicity invariant on delegated decisions.
   *
   * MAX_AUDIENCE is a 400, never a truncated send. A silently truncated audience
   * and a silent drop are the same bug: both report success for people who were
   * never told.
   */
  app.post('/api/notifications/send-to-audience', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as Partial<SendToAudienceInput>;
    const errors: string[] = [];

    if (!b.tenant_id) errors.push('tenant_id is required');
    if (!b.body) errors.push('body is required');
    if (!Array.isArray(b.channels) || b.channels.length === 0) {
      errors.push('channels must be a non-empty array');
    } else {
      const bad = b.channels.filter((c) => !DISPATCH_CHANNELS.includes(c));
      if (bad.length) errors.push(`channel must be one of ${DISPATCH_CHANNELS.join(', ')}`);
    }

    const aud = b.audience;
    if (!aud || typeof aud !== 'object') {
      errors.push('audience is required');
    } else if (aud.kind === 'persona') {
      if (!Array.isArray(aud.persona_ids) || aud.persona_ids.length === 0) {
        errors.push('audience.persona_ids must be a non-empty array');
      } else if (aud.persona_ids.length > MAX_AUDIENCE) {
        errors.push(`audience exceeds the ${MAX_AUDIENCE} recipient ceiling — narrow the audience rather than relying on truncation`);
      }
    } else if (aud.kind === 'role') {
      if (!aud.role_template_id) errors.push('audience.role_template_id is required');
    } else {
      errors.push("audience.kind must be 'persona' or 'role'");
    }

    const auth = b.authorization;
    if (!auth || typeof auth !== 'object') {
      errors.push('authorization is required — a send with no recorded decision is not permitted');
    } else if (!['platform', 'delegated', 'exempt'].includes(auth.mode)) {
      errors.push("authorization.mode must be 'platform', 'delegated' or 'exempt'");
    }

    if (errors.length) return reply.code(400).send({ error: 'ValidationError', details: errors });

    try {
      const result = await sendToAudience(b as SendToAudienceInput);
      return reply.code(200).send({ data: result });
    } catch (err) {
      if (err instanceof AudienceAuthorizationError) {
        // 403, not 400: the request is well-formed and the caller is authenticated —
        // what is missing is permission to send, which is a different fix.
        return reply.code(403).send({ error: 'Forbidden', code: err.code, details: [err.message] });
      }
      throw err;
    }
  });

  app.post('/api/notifications/send', { preHandler: requireAuth }, async (req, reply) => {
    // Provider gate (EP-341): the send channel needs a configured provider; when
    // none is set at tenant/app/platform, return a clear 503 PROVIDER_NOT_CONFIGURED
    // instead of a downstream 500 / silent stub.
    const channel = (req.body as { channel?: string } | undefined)?.channel ?? 'email';
    const providerKey = channel === 'email' ? 'notification.email.credential' : `notification.${channel}.credential`;
    const notConfigured = await checkProviderConfigured(providerKey, ctxFrom(req));
    if (notConfigured) return reply.code(503).send(notConfigured);
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
      // P16 EP-383 — all optional; omitting them preserves the pre-existing behaviour.
      purpose: string; respect_frequency_cap: boolean; dedup_key: string; auto_dedup: boolean;
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
      purpose: body.purpose, respect_frequency_cap: body.respect_frequency_cap,
      dedup_key: body.dedup_key, auto_dedup: body.auto_dedup,
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

  /* ------------------------------------------------------------------------
   * Frequency caps + no-answer dedup window (P16 EP-383). NEW routes only —
   * every endpoint above is untouched, which is what keeps this additive.
   * ---------------------------------------------------------------------- */

  app.put('/api/notifications/frequency-policy', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; channel: string; purpose: string;
      max_per_day: number | null; dedup_window_seconds: number; updated_by: string;
    }>;
    const details: string[] = [];
    if (!body.tenant_id) details.push('tenant_id is required');
    // null is meaningful (uncapped) and must not be conflated with a missing field.
    if (body.max_per_day !== undefined && body.max_per_day !== null && (!Number.isInteger(body.max_per_day) || body.max_per_day < 0)) {
      details.push('max_per_day must be a non-negative integer, or null for uncapped');
    }
    if (body.dedup_window_seconds !== undefined
        && (!Number.isInteger(body.dedup_window_seconds) || body.dedup_window_seconds < 0 || body.dedup_window_seconds > 604800)) {
      details.push('dedup_window_seconds must be an integer between 0 and 604800 (7 days)');
    }
    if (details.length) return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details });

    const policy = await setFrequencyPolicy({
      tenant_id: body.tenant_id!,
      channel: body.channel,
      purpose: body.purpose,
      max_per_day: body.max_per_day,
      dedup_window_seconds: body.dedup_window_seconds,
      updated_by: body.updated_by,
    });
    return reply.code(200).send({ data: { policy } });
  });

  /* ------------------------------------------------------------------------
   * Send-window pre-flight. NEW — this route did not previously exist anywhere
   * in the platform, though callers were written against it: the verdict was
   * only obtainable as a side effect of attempting a send. Read-only; see
   * sendWindow.ts for why a check that reserved capacity would be worse than
   * no check at all.
   * ---------------------------------------------------------------------- */

  function parseSendWindowItem(
    raw: unknown,
    credentialTenant: string | null,
  ): { ok: true; value: SendWindowQuery } | { ok: false; errors: string[] } {
    const b = (raw ?? {}) as Partial<{
      tenant_id: string; channel: string; subject_persona_id: string; purpose: string; at: string;
    }>;
    const errors: string[] = [];
    const tenant_id = b.tenant_id ?? credentialTenant;
    if (!tenant_id) errors.push('tenant_id is required (absent from the request and from the credential)');
    if (!b.channel) errors.push('channel is required');
    else if (!DISPATCH_CHANNELS.includes(b.channel as NotificationChannel)) {
      errors.push(`channel must be one of ${DISPATCH_CHANNELS.join(', ')}`);
    }
    // An unparseable `at` is rejected rather than silently falling back to now:
    // a caller planning a 09:00 send that is quietly answered for 03:00 gets a
    // verdict about the wrong moment, which is the one failure mode a
    // send-window check must not have.
    let at: Date | undefined;
    if (b.at !== undefined) {
      const parsed = new Date(b.at);
      if (Number.isNaN(parsed.getTime())) errors.push('at must be an ISO-8601 timestamp');
      else at = parsed;
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        tenant_id: tenant_id!,
        channel: b.channel!,
        subject_persona_id: b.subject_persona_id,
        purpose: b.purpose,
        at,
      },
    };
  }

  app.post('/api/notifications/send-window', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = parseSendWindowItem(req.body, ctxFrom(req).tenant_id ?? null);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details: parsed.errors });
    }
    const verdict = await checkSendWindow(parsed.value);
    return reply.code(200).send({ data: { send_window: verdict } });
  });

  app.post('/api/notifications/send-window/bulk', { preHandler: requireAuth }, async (req, reply) => {
    const envelope = parseBulkEnvelope(req.body);
    if (!envelope.ok) {
      return reply.code(400).send({ error: envelope.error, details: envelope.details });
    }
    const credentialTenant = ctxFrom(req).tenant_id ?? null;

    const queries: BulkSendWindowQuery[] = [];
    const results: BulkItemResult<{ send_window: SendWindowVerdict }>[] = [];
    envelope.items.forEach((raw, index) => {
      const parsed = parseSendWindowItem(raw, credentialTenant);
      if (!parsed.ok) {
        results.push(bulkItemError(index, 'VALIDATION_ERROR', parsed.errors.join('; ')));
        return;
      }
      queries.push({ ...parsed.value, index });
    });

    for (const row of await checkSendWindowBulk(queries)) {
      results.push({ index: row.index, ok: true, send_window: row.verdict });
    }
    results.sort((a, b) => a.index - b.index);
    return reply.code(200).send({ data: bulkResponse(results) });
  });

  app.get<{ Querystring: { tenant_id?: string; channel?: string; purpose?: string } }>(
    '/api/notifications/frequency-policy', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details: ['tenant_id query param required'] });
      }
      const policies = await listFrequencyPolicies(req.query.tenant_id);
      // When a channel is named, also return the RESOLVED policy and current usage — the
      // question a caller actually has is "may I send now", not "what rows exist".
      const usage = req.query.channel
        ? await getSendUsage({ tenant_id: req.query.tenant_id, channel: req.query.channel, purpose: req.query.purpose })
        : undefined;
      return reply.code(200).send({ data: { policies, ...(usage ? { usage } : {}) } });
    },
  );
}
