import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  checkConsentHandler,
  exportReceiptsHandler,
  grantConsentHandler,
  registerPurposeHandler,
  revokeConsentHandler,
} from './handlers/consentController';
import { getReceiptState } from '../services/consentService';

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
