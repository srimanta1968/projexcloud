import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  archiveItem,
  createItem,
  createVersion,
  getItem,
  listVersions,
  publishVersion,
  upsertTaxonomy,
} from '../services/contentService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/content/items', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; type_code: string; slug: string; owner_persona_id: string }>;
    if (!body.tenant_id || !body.type_code || !body.slug) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await createItem({
      tenant_id: body.tenant_id,
      type_code: body.type_code,
      slug: body.slug,
      owner_persona_id: body.owner_persona_id,
    });
    return reply.code(201).send({ data: { item: rec } });
  });

  app.get<{ Params: { item_id: string } }>(
    '/api/content/items/:item_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getItem(req.params.item_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { item: rec } });
    },
  );

  app.post<{ Params: { item_id: string } }>(
    '/api/content/items/:item_id/versions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        payload: Record<string, unknown>;
        media_refs: string[];
        taxonomy_tags: string[];
      }>;
      const rec = await createVersion({
        item_id: req.params.item_id,
        payload: body.payload ?? {},
        media_refs: body.media_refs,
        taxonomy_tags: body.taxonomy_tags,
      });
      return reply.code(201).send({ data: { version: rec } });
    },
  );

  app.get<{ Params: { item_id: string } }>(
    '/api/content/items/:item_id/versions',
    { preHandler: requireAuth },
    async (req, reply) => {
      const recs = await listVersions(req.params.item_id);
      return reply.code(200).send({ data: { versions: recs } });
    },
  );

  app.post<{ Params: { item_id: string; version_id: string } }>(
    '/api/content/items/:item_id/versions/:version_id/publish',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ published_by: string }>;
      if (!body.published_by) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing published_by'] });
      }
      const rec = await publishVersion(req.params.item_id, req.params.version_id, body.published_by);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { item: rec } });
    },
  );

  app.post<{ Params: { item_id: string } }>(
    '/api/content/items/:item_id/archive',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await archiveItem(req.params.item_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { item: rec } });
    },
  );

  app.put('/api/content/taxonomies', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; name: string; structure: Record<string, unknown> }>;
    if (!body.tenant_id || !body.name) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await upsertTaxonomy(body.tenant_id, body.name, body.structure ?? {});
    return reply.code(200).send({ data: { taxonomy: rec } });
  });
}
