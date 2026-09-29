import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { getCatalogEntry, listCatalog, type CatalogFilter } from '../services/catalogService';
import { sendError } from './sendError';

/**
 * sdk-speech HTTP surface under /api/speech/* (VA·E4), mounted by the api-gateway.
 * The catalog is global reference data: any authenticated tenant reads the same rows.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // TK-4489 — the provider catalog.
  app.get('/api/speech/catalog', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as CatalogFilter;
    try {
      const entries = await listCatalog({ layer: q.layer, provider: q.provider, certified: q.certified });
      return reply.code(200).send({ data: { entries, total: entries.length } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/speech/catalog/:entry_id', { preHandler: requireAuth }, async (req, reply) => {
    const { entry_id } = req.params as { entry_id: string };
    try {
      return reply.code(200).send({ data: { entry: await getCatalogEntry(entry_id) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
