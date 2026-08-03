import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  checkRelationshipHandler,
  createRelationshipHandler,
  updateScopeHandler,
  grantRoleHandler,
  listRolesHandler,
  attestRoleHandler,
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

  /* ---- Bitemporal contextual roles (P16 EP-384). NEW routes only. ---- */

  app.post('/api/relationships/roles', { preHandler: requireAuth }, async (req, reply) => {
    try { await grantRoleHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/relationships/roles', { preHandler: requireAuth }, async (req, reply) => {
    try { await listRolesHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post<{ Params: { relationship_id: string } }>(
    '/api/relationships/:relationship_id/attest',
    { preHandler: requireAuth },
    async (req, reply) => {
      try { await attestRoleHandler(req, reply); }
      catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
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
