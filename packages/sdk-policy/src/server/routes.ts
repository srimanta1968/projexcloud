import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createPolicyHandler,
  evaluatePolicyHandler,
  getPolicyHandler,
} from './handlers/policyController';

/**
 * Registers /api/policies/* routes per P2 §8.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/policies', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await createPolicyHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });

  app.get<{ Params: { policy_id: string } }>(
    '/api/policies/:policy_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        await getPolicyHandler(req, reply);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  app.post('/api/policies/evaluate', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await evaluatePolicyHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
