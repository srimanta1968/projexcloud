import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  checkConsentBulkHandler,
  checkConsentHandler,
  exportReceiptsHandler,
  grantConsentHandler,
  listPurposesHandler,
  registerPurposeHandler,
  revokeConsentHandler,
} from './handlers/consentController';
import { getReceiptState } from '../services/consentService';

/** Canonical uuid shape — guards path params before they reach a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Registers /api/consents/* routes per P2-Identity-Access §6.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/consents/purposes', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await registerPurposeHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // Reads the registry the POST above writes into. Registered adjacent to it so
  // the pair is impossible to miss — the absence of this route is what made
  // GET /api/consents/purposes bind ':receipt_id' to "purposes" and answer 500,
  // so an integrator probing for a list was told the consent service was down.
  //
  // Fastify matches static segments ahead of parameterised ones, so this wins over
  // '/api/consents/:receipt_id' regardless of registration order.
  app.get<{ Querystring: { app_id?: string; category?: string; legal_basis?: string; limit?: string; offset?: string } }>(
    '/api/consents/purposes',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await listPurposesHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post('/api/consents', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await grantConsentHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: { receipt_id: string } }>(
    '/api/consents/:receipt_id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await revokeConsentHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  // Point read of ONE receipt — "is the basis I recorded still valid?".
  //
  // Registered BEFORE /api/consents/check would be a mistake in the other direction:
  // Fastify matches static segments ahead of parameterised ones, so ':receipt_id'
  // cannot swallow '/check' or '/export' regardless of order. Placed here for reading
  // order, next to the check it complements.
  //
  // See getReceiptState for why this is not the same question as POST /check: check
  // asks whether ANY active consent exists for a four-tuple, which a later receipt can
  // satisfy; this asks whether THE receipt something was already captured under is
  // still good. For a call recording or an export, the second is the one that matters.
  app.get<{ Params: { receipt_id: string } }>(
    '/api/consents/:receipt_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const tenant_id = req.auth?.tenant_id ?? '';
        if (!tenant_id) {
          return reply.code(403).send({
            success: false,
            error: 'This token carries no tenant, so no receipt scope can be derived',
          });
        }
        // A receipt_id that is not a uuid never reaches the database. Without this
        // the lookup reached Postgres, failed to parse the literal, and surfaced as
        // 500 InternalError — so probing a plausible collection path answered
        // "the server is broken" instead of "there is nothing here". That is not a
        // hypothetical: GET /api/consents/purposes binds ':receipt_id' to "purposes"
        // (there is no purposes-list route), and an integrator looking for one was
        // told the consent service was down.
        //
        // 404 rather than 400, matching the tenant rule below: this route's answer to
        // "does this name a receipt I may read" is always the same shape, and a
        // distinguishable response is itself a disclosure.
        if (!UUID_RE.test(req.params.receipt_id)) {
          return reply.code(404).send({ success: false, error: 'Receipt not found' });
        }
        const state = await getReceiptState(req.params.receipt_id, tenant_id);
        // 404, never 403, for a receipt in another tenant: a receipt names a person and
        // a purpose, so confirming one exists elsewhere is itself the disclosure.
        if (!state) return reply.code(404).send({ success: false, error: 'Receipt not found' });
        return reply.send({ success: true, data: state });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post('/api/consents/check', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await checkConsentHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  // N tuples, one query. See checkConsentBulk for why a loop behind this route
  // would not be a fix.
  app.post('/api/consents/check/bulk', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await checkConsentBulkHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.get<{ Querystring: { person_id?: string } }>(
    '/api/consents/export',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await exportReceiptsHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );
}
