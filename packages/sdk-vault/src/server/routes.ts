import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  decryptHandler,
  encryptHandler,
  issueHandler,
  rotateHandler,
  shredHandler,
} from './handlers/keyController';
import { requireAuth } from '@projexlight/sdk-identity';

interface KeyIdParams {
  key_id: string;
}

/**
 * Registers /api/vault/* routes per P1-Foundation-Spine §6. All key ops + the
 * envelope encrypt/decrypt API require a valid JWT.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/vault/health', async () => ({ sdk: 'sdk-vault', status: 'ok' }));

  app.post('/api/vault/keys', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await issueHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: KeyIdParams; Body: { reason?: string } }>('/api/vault/keys/:key_id/rotate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await rotateHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: KeyIdParams; Body: { reason?: string } }>('/api/vault/keys/:key_id/shred', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await shredHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/vault/encrypt', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await encryptHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/vault/decrypt', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await decryptHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
