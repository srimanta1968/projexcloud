import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  suppress,
  isSuppressed,
  unsuppress,
  listSuppressions,
  issueOptoutToken,
  redeemOptoutToken,
  type Channel,
  type SuppressionReason,
  type SuppressionScope,
} from '../services/suppressionService';
import {
  upsertWebhookSecret,
  verifyWebhookSignature,
  processBounceWebhook,
  listBounceEvents,
  type Provider,
} from '../services/webhookService';

/**
 * sdk-deliverability Fastify routes (P14·E3, TK-3624). The pre-send suppression
 * enforcement surface every send path calls before delivering: check (is this
 * recipient suppressed?), plus suppress / unsuppress / list and single-purpose
 * opt-out token issue/redeem. All tenant-authed; addresses are hashed server-side
 * (never stored raw). tenant_id is carried in the body/query as in the sibling SDKs.
 */
const CHANNELS: Channel[] = ['email', 'sms', 'all'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Pre-send enforcement: single {address} or batch {addresses:[]}. Returns whether
  // each recipient is suppressed for the tenant (or globally). Call before EVERY send.
  app.post('/api/deliverability/check', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; channel?: Channel; address?: string; addresses?: string[] };
    if (!body.tenant_id || !body.channel) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and channel are required'] });
    }
    if (!CHANNELS.includes(body.channel)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['channel must be email, sms or all'] });
    }
    if (Array.isArray(body.addresses) && body.addresses.length) {
      const results = await Promise.all(body.addresses.map(async (address) => ({
        address, suppressed: await isSuppressed({ tenantId: body.tenant_id!, channel: body.channel!, address }),
      })));
      return reply.code(200).send({ data: { results } });
    }
    if (!body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['address or addresses[] is required'] });
    }
    const suppressed = await isSuppressed({ tenantId: body.tenant_id, channel: body.channel, address: body.address });
    return reply.code(200).send({ data: { suppressed } });
  });

  // Add (or refresh) a suppression.
  app.post('/api/deliverability/suppressions', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; channel: Channel; address: string; reason: SuppressionReason;
      reason_detail: string; source: string; subject_persona_id: string; scope: SuppressionScope; expires_at: string;
    }>;
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    const suppression = await suppress({
      tenantId: body.tenant_id, channel: body.channel, address: body.address, reason: body.reason,
      reasonDetail: body.reason_detail, source: body.source, subjectPersonaId: body.subject_persona_id,
      scope: body.scope, expiresAt: body.expires_at,
    });
    return reply.code(201).send({ data: { suppression } });
  });

  // List suppressions (tenant + global rows).
  app.get<{ Querystring: { tenant_id?: string; channel?: Channel; limit?: string } }>(
    '/api/deliverability/suppressions', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const suppressions = await listSuppressions({
        tenantId: req.query.tenant_id,
        channel: req.query.channel && CHANNELS.includes(req.query.channel) ? req.query.channel : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { suppressions } });
    },
  );

  // Remove a suppression (un-suppress an address).
  app.post('/api/deliverability/suppressions/remove', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; channel?: Channel; address?: string; scope?: SuppressionScope };
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    await unsuppress({ tenantId: body.tenant_id, channel: body.channel, address: body.address, scope: body.scope });
    return reply.code(200).send({ data: { removed: true } });
  });

  // Mint a single-purpose opt-out (unsubscribe) token. The raw token is returned ONCE.
  app.post('/api/deliverability/optout-tokens', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; channel: Channel; address: string; purpose: 'unsubscribe' | 'resubscribe' | 'preferences';
      subject_persona_id: string; scope: SuppressionScope; ttl_seconds: number;
    }>;
    if (!body.tenant_id || !body.channel || !body.address) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, channel and address are required'] });
    }
    const token = await issueOptoutToken({
      tenantId: body.tenant_id, channel: body.channel, address: body.address, purpose: body.purpose,
      subjectPersonaId: body.subject_persona_id, scope: body.scope, ttlSeconds: body.ttl_seconds,
    });
    return reply.code(201).send({ data: { token_id: token.tokenId, token: token.token } });
  });

  // Redeem an opt-out token (one-time) → suppress the address + write an opt-out event.
  app.post('/api/deliverability/optout/redeem', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; feedback?: string };
    if (!body.token) return reply.code(400).send({ error: 'ValidationError', details: ['token is required'] });
    const redeemed = await redeemOptoutToken(body.token, body.feedback);
    if (!redeemed) return reply.code(410).send({ error: 'Gone', details: ['token is unknown, already used, or expired'] });
    return reply.code(200).send({ data: { redeemed: true } });
  });

  /* ------------------------------- provider bounce/complaint webhooks (TK-3625) */
  const PROVIDERS: Provider[] = ['ses', 'sendgrid', 'mailgun', 'postmark', 'twilio'];

  // Register (or rotate) a tenant's HMAC signing secret for a provider webhook.
  app.post('/api/deliverability/webhook-secrets', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; provider: Provider; signing_secret: string; algo: 'sha1' | 'sha256' }>;
    if (!body.tenant_id || !body.provider || !body.signing_secret) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, provider and signing_secret are required'] });
    }
    if (!PROVIDERS.includes(body.provider)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['provider must be ses, sendgrid, mailgun, postmark or twilio'] });
    }
    const secret = await upsertWebhookSecret({
      tenantId: body.tenant_id, provider: body.provider, signingSecret: body.signing_secret, algo: body.algo,
    });
    return reply.code(201).send({ data: { secret_id: secret.secret_id, provider: secret.provider } });
  });

  // Provider bounce/complaint webhook receiver. PUBLIC (on the authGate allowlist) but
  // HMAC-verified when a signing secret is configured for the (tenant, provider). The
  // tenant is carried on the per-tenant webhook URL via ?tenant_id=. Hard bounces +
  // complaints auto-suppress the recipient.
  app.post<{ Params: { provider: string }; Querystring: { tenant_id?: string } }>(
    '/api/deliverability/webhooks/:provider', async (req, reply) => {
      const provider = req.params.provider as Provider;
      if (!PROVIDERS.includes(provider)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['unknown provider'] });
      }
      const tenantId = req.query.tenant_id;
      if (!tenantId) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });

      const rawBody = JSON.stringify(req.body ?? {});
      const signature = (req.headers['x-webhook-signature']
        || req.headers['x-twilio-email-event-webhook-signature']
        || req.headers['x-mailgun-signature']
        || req.headers['signature']) as string | undefined;
      const { verified, enforced } = await verifyWebhookSignature(tenantId, provider, rawBody, signature);
      if (enforced && !verified) {
        return reply.code(401).send({ error: 'InvalidSignature', details: ['webhook HMAC signature verification failed'] });
      }
      const result = await processBounceWebhook({ tenantId, provider, payload: req.body, signatureVerified: verified });
      return reply.code(200).send({ data: result });
    },
  );

  // List processed bounce/complaint events for a tenant.
  app.get<{ Querystring: { tenant_id?: string; classification?: string; limit?: string } }>(
    '/api/deliverability/bounce-events', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const events = await listBounceEvents(req.query.tenant_id, {
        classification: req.query.classification,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return reply.code(200).send({ data: { events } });
    },
  );
}
