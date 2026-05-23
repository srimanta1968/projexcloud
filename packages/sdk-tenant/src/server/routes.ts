import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  attachResellerHandler,
  createBuHandler,
  createGeoNodeHandler,
  createResellerHandler,
  createRoleTemplateHandler,
  createSubTenantHandler,
  createTenantHandler,
  getTenantHandler,
  setFiscalCalendarHandler,
} from './handlers/tenantController';

/**
 * Registers /api/tenants/* and adjacent /api/resellers, /api/geo-nodes,
 * /api/role-templates routes per P2-Identity-Access §4.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tenants', { preHandler: requireAuth }, async (req, reply) => {
    try { await createTenantHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get<{ Params: { tenant_id: string } }>(
    '/api/tenants/:tenant_id', { preHandler: requireAuth }, async (req, reply) => {
      try { await getTenantHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    });

  app.post('/api/resellers', { preHandler: requireAuth }, async (req, reply) => {
    try { await createResellerHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenants/:tenant_id/reseller-attach', { preHandler: requireAuth }, async (req, reply) => {
      try { await attachResellerHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    });

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenants/:tenant_id/sub-tenants', { preHandler: requireAuth }, async (req, reply) => {
      try { await createSubTenantHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    });

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenants/:tenant_id/bus', { preHandler: requireAuth }, async (req, reply) => {
      try { await createBuHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    });

  app.post('/api/geo-nodes', { preHandler: requireAuth }, async (req, reply) => {
    try { await createGeoNodeHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/role-templates', { preHandler: requireAuth }, async (req, reply) => {
    try { await createRoleTemplateHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenants/:tenant_id/fiscal-calendar', { preHandler: requireAuth }, async (req, reply) => {
      try { await setFiscalCalendarHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
    });
}
