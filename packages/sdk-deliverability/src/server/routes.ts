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
}
