import { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { requireAuth } from '@projexlight/sdk-identity';
import { checkProviderConfigured } from '@projexlight/sdk-config';
import { resolvePaymentProviderByScope } from '../services/paymentProviderResolver';
import {
  attachMethodHandler,
  chargeHandler,
  distributeHandler,
  refundHandler,
} from './handlers/paymentController';
import {
  handleStripeWebhook,
  verifyStripeWebhook,
} from './handlers/stripeWebhookHandler';

/** Build the config-resolution context from the caller's JWT (set by requireAuth). */
function ctxFrom(req: FastifyRequest): { tenant_id?: string | null; app_id?: string | null; app_user_id?: string | null } {
  const a = (req as unknown as { auth?: { sub?: string; tenant_id?: string | null; app_id?: string | null } }).auth ?? {};
  return { tenant_id: a.tenant_id ?? null, app_id: a.app_id ?? null, app_user_id: a.sub ?? null };
}

/**
 * Registers /api/payments/* routes per P4-Operational-Billing §6.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/payments/methods', { preHandler: requireAuth }, async (req, reply) => {
    const notConfigured = await checkProviderConfigured('payment.provider', ctxFrom(req));
    if (notConfigured) return reply.code(503).send(notConfigured);
    try { await attachMethodHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/payments/charge', { preHandler: requireAuth }, async (req, reply) => {
    const notConfigured = await checkProviderConfigured('payment.provider', ctxFrom(req));
    if (notConfigured) return reply.code(503).send(notConfigured);
    try { await chargeHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  // Two-level payment-provider resolution (EP-341): which provider is configured
  // for this caller at a given level — 'collect' (tenant collects from end-users,
  // resolves tenant->platform) or 'billing' (how the tenant pays ProjexLight,
  // platform-scope only). Returns {configured, provider, scope, value}.
  app.get<{ Querystring: { level?: string } }>(
    '/api/payments/provider',
    { preHandler: requireAuth },
    async (req, reply) => {
      const level = req.query.level === 'billing' ? 'billing' : 'collect';
      const data = await resolvePaymentProviderByScope(ctxFrom(req), level);
      return reply.send({ data });
    },
  );

  app.post<{ Params: { charge_id: string } }>(
    '/api/payments/:charge_id/refund',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await refundHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  app.post<{ Params: { charge_id: string } }>(
    '/api/payments/:charge_id/distribute',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await distributeHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    },
  );

  /**
   * Stripe webhook receiver — signature-authenticated, no requireAuth.
   *
   * We MUST hand the raw bytes (not JSON-parsed) to Stripe's
   * constructEvent for HMAC verification. We register the route inside an
   * encapsulated plugin scope so the custom content-type parser is local
   * to this one route and does NOT clobber the gateway-wide JSON parser
   * (other SDKs would break otherwise).
   *
   * Response codes:
   *   200 — handled (or unknown event type; Stripe stops retrying)
   *   400 — bad signature / missing raw body (Stripe retries with backoff)
   *   500 — handler error (Stripe retries over its 3-day window)
   */
  await app.register(async (scoped) => {
    // The gateway now registers an explicit root JSON parser (so a bodyless
    // POST means {} instead of 400). An explicit parent parser cannot simply be
    // shadowed the way Fastify's built-in default can — adding the same type in
    // a child scope raises FST_ERR_CTP_ALREADY_PRESENT and takes the whole
    // gateway down at boot. Removing it inside THIS scope first restores the
    // intent: raw bytes here, ordinary JSON everywhere else.
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        // Stash the raw bytes for signature verification AND surface the
        // parsed JSON to fastify so reply lifecycle still works.
        try {
          const buf = body as Buffer;
          (_req as FastifyRequest & { rawBody?: Buffer }).rawBody = buf;
          const json = buf.length ? JSON.parse(buf.toString('utf8')) : {};
          done(null, json);
        } catch (err) {
          done(err as Error);
        }
      },
    );

    scoped.post('/api/payments/webhooks/stripe', async (req, reply) => {
      const sig = req.headers['stripe-signature'];
      const sigHeader = Array.isArray(sig) ? sig[0] : sig;
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!raw) {
        reply.code(400).send({ error: 'MissingRawBody' });
        return;
      }
      let event: Stripe.Event;
      try {
        event = verifyStripeWebhook(raw, sigHeader);
      } catch (err) {
        req.log.warn({ err }, 'stripe webhook signature verification failed');
        reply.code(400).send({ error: 'InvalidSignature' });
        return;
      }
      try {
        await handleStripeWebhook(event);
        reply.code(200).send({ received: true });
      } catch (err) {
        req.log.error({ err, event_type: event.type, event_id: event.id }, 'stripe webhook handler error');
        reply.code(500).send({ error: 'HandlerError' });
      }
    });
  });
}
