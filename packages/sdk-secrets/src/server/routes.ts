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

  /**
   * THE :ref ROUTES ABOVE CANNOT MATCH A CONFORMANT REFERENCE.
   *
   * secretRefCatalog validates every reference against
   *   /^secret:\/\/(app|pool|tenant)\/(.+)$/
   * so a valid ref ALWAYS contains '://' and at least one more '/' — three or more path
   * segments. A Fastify ':ref' parameter matches exactly ONE segment, so every real ref
   * 404s and the only requests those routes could ever serve are malformed ones.
   *
   * The two routes below take the reference somewhere a slash is not a delimiter — the
   * query string for the read, the body for the rotate. The originals are kept rather
   * than deleted: they are harmless, and something may already point at them for a
   * single-segment id.
   */
  app.get<{ Querystring: { ref?: string } }>('/api/secrets', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const ref = (req.query?.ref ?? '').trim();
      if (!ref) {
        reply.code(400).send({
          error: 'ValidationError',
          details: ['ref query parameter is required, e.g. ?ref=secret://tenant/my-key'],
        });
        return;
      }
      // retrieveHandler reads params.ref; give it the same shape rather than duplicating it.
      (req as any).params = { ...(req.params as object), ref };
      await retrieveHandler(req as any, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post<{ Body: { ref?: string } }>('/api/secrets/rotate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { ref?: string };
      const ref = (body.ref ?? '').trim();
      if (!ref) {
        reply.code(400).send({
          error: 'ValidationError',
          details: ['ref is required in the body, e.g. { "ref": "secret://tenant/my-key" }'],
        });
        return;
      }
      (req as any).params = { ...(req.params as object), ref };
      await rotateHandler(req as any, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
