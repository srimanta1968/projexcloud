import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  checkConsentHandler,
  exportReceiptsHandler,
  grantConsentHandler,
  registerPurposeHandler,
  revokeConsentHandler,
} from './handlers/consentController';

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
