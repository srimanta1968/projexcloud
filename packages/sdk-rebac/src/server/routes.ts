import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  checkRelationshipHandler,
  createRelationshipHandler,
  updateScopeHandler,
} from './handlers/rebacController';

/**
 * Registers /api/relationships/* routes per P2 §9.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/relationships', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await createRelationshipHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.put<{ Params: { relationship_id: string } }>(
    '/api/relationships/:relationship_id/scope',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await updateScopeHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post('/api/relationships/check', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await checkRelationshipHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
