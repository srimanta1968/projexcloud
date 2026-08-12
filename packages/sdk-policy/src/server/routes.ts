import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createPolicyHandler,
  evaluatePolicyBulkHandler,
  evaluatePolicyHandler,
  getPolicyHandler,
} from './handlers/policyController';
import { listPoliciesForScope } from '../services/policyService';

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

  /**
   * GET /api/policies?app_id=… — the rules in force for a scope.
   *
   * Tenant comes from the credential, never the query: a policy names what a
   * caller may do, so letting one be listed by naming somebody else's tenant
   * would hand over their access model.
   */
  app.get<{ Querystring: { app_id?: string } }>(
    '/api/policies',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tenant_id = req.auth?.tenant_id;
      if (!tenant_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          details: ['This credential carries no tenant context'],
        });
      }
      try {
        const policies = await listPoliciesForScope(tenant_id, req.query?.app_id);
        return reply.send({ data: { policies } });
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

  // N evaluations, one policy read per distinct policy. See evaluatePolicyBulk
  // for what it collapses and for the one semantic it deliberately gives up
  // (per-subject audit events become one aggregate event per policy).
  app.post('/api/policies/evaluate/bulk', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await evaluatePolicyBulkHandler(req, reply);
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
