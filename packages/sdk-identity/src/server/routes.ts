import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginHandler, registerHandler } from './handlers/authController';

/**
 * Registers /api/auth/* routes on the host Fastify instance.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await registerHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await loginHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
