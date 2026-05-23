import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { explain, resolveIdentityContext } from '../services/resolverService';

/**
 * Resolver HTTP surface. Most callers should use the in-process
 * resolveIdentityContext() function directly; these routes exist for
 * debugging and cross-service callers that aren't in the TS monorepo.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/resolver/resolve', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      person_id: string;
      app_id: string;
      tenant_id: string;
      bypass_cache: boolean;
    }>;
    if (!body.person_id || !body.app_id || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing required fields'] });
    }
    const ctx = await resolveIdentityContext({
      person_id: body.person_id,
      app_id: body.app_id,
      tenant_id: body.tenant_id,
      options: { bypass_cache: body.bypass_cache },
    });
    return reply.code(200).send({ data: { identity_context: ctx } });
  });

  app.post('/api/resolver/explain', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      person_id: string;
      app_id: string;
      tenant_id: string;
      attribute: string;
    }>;
    if (!body.person_id || !body.app_id || !body.tenant_id || !body.attribute) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing required fields'] });
    }
    const ctx = await resolveIdentityContext({
      person_id: body.person_id,
      app_id: body.app_id,
      tenant_id: body.tenant_id,
    });
    return reply.code(200).send({ data: { provenance: explain(ctx, body.attribute) } });
  });
}
