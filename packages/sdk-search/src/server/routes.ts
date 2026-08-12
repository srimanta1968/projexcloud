import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { searchClientState } from '../services/searchClient';
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
  /*
   * Is search actually usable in this deployment?
   *
   * WHY THIS EXISTS. Without it, "search is not wired here" and "search ran and
   * matched nothing" are indistinguishable to a caller: an unwired deployment
   * 500s every query, and a consuming app reasonably renders that as an empty
   * result set. A shipped feature then reports "0 results" for a backend that was
   * never connected, which is the most misleading answer available — it looks
   * like a fact about the data.
   *
   * 200 EVEN WHEN UNAVAILABLE, DELIBERATELY. This reports a capability state; it
   * is not itself failing. Answering 503 would make a caller's own health check
   * flap and would conflate "the probe is broken" with "the thing it probes is
   * unavailable". Read `available`, not the status code.
   *
   * No auth: it discloses nothing about any tenant's data, only whether a backend
   * is configured, and a caller needs it precisely when it cannot authenticate a
   * search.
   */
  app.get('/api/search/health', async (_req, reply) => {
    const state = searchClientState();
    return reply.code(200).send({
      data: {
        search_up: state.available,
        client: state.kind,
        ...(state.reason ? { reason: state.reason } : {}),
      },
    });
  });

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
