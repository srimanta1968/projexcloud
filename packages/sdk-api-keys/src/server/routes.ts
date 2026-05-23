import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  issueKeyHandler,
  listKeysHandler,
  revokeKeyHandler,
  rotateKeyHandler,
} from './handlers/apiKeyController';

/**
 * Registers /api/api-keys/* routes per P2 §5.6.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/api-keys', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await issueKeyHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/api-keys',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await listKeysHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post<{ Params: { key_id: string } }>(
    '/api/api-keys/:key_id/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await revokeKeyHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post<{ Params: { key_id: string } }>(
    '/api/api-keys/:key_id/rotate',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await rotateKeyHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );
}
