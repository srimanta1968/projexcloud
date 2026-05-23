import { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { requireAuth } from '@projexlight/sdk-identity';
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

/**
 * Registers /api/payments/* routes per P4-Operational-Billing §6.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/payments/methods', { preHandler: requireAuth }, async (req, reply) => {
    try { await attachMethodHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/payments/charge', { preHandler: requireAuth }, async (req, reply) => {
    try { await chargeHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

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
