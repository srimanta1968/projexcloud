import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveTenantPool } from '../services/poolRegistry';

interface ResolveQuery {
  tenant_id?: string;
  app_id?: string;
}

/**
 * Registers /api/router/* routes. `GET /api/router/resolve?tenant_id=&app_id=`
 * returns the active pool record for the tuple, or 404 if no mapping.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/router/resolve', async (req: FastifyRequest<{ Querystring: ResolveQuery }>, reply: FastifyReply) => {
    try {
      const tenant_id = req.query.tenant_id?.trim();
      const app_id = req.query.app_id?.trim();
      if (!tenant_id || !app_id) {
        reply.code(400).send({
          error: 'ValidationError',
          details: ['tenant_id and app_id are required'],
        });
        return;
      }
      const pool = await resolveTenantPool(tenant_id, app_id);
      if (!pool) {
        reply.code(404).send({
          error: 'NotFound',
          details: ['No active pool mapping for this tenant and app'],
        });
        return;
      }
      reply.code(200).send({ data: pool });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
