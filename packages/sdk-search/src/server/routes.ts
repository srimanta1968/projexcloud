import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  listSavedQueriesHandler,
  queryHandler,
  registerIndexHandler,
  saveQueryHandler,
} from './handlers/searchController';

/**
 * Registers /api/search/* routes per P4-Operational-Billing §8.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Both GET (for ?q=text query-string searches) and POST (for full DSL bodies).
  app.get('/api/search', { preHandler: requireAuth }, async (req, reply) => {
    try { await queryHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/search', { preHandler: requireAuth }, async (req, reply) => {
    try { await queryHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/search/index', { preHandler: requireAuth }, async (req, reply) => {
    try { await registerIndexHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.post('/api/search/saved-queries', { preHandler: requireAuth }, async (req, reply) => {
    try { await saveQueryHandler(req, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });

  app.get('/api/search/saved-queries', { preHandler: requireAuth }, async (req, reply) => {
    try { await listSavedQueriesHandler(req as never, reply); }
    catch (err) { req.log.error(err); if (!reply.sent) reply.code(500).send({ error: 'InternalError' }); }
  });
}
