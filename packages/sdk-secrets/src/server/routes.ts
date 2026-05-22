import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { storeHandler, retrieveHandler, rotateHandler } from './handlers/secretController';
import { requireAuth } from '@projexlight/sdk-identity';

interface RefParams { ref: string }

/**
 * Registers /api/secrets/* routes per P1-Foundation-Spine §5. All routes
 * require a valid JWT.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/secrets', { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await storeHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.get<{ Params: RefParams }>('/api/secrets/:ref', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await retrieveHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Params: RefParams }>('/api/secrets/:ref/rotate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await rotateHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
