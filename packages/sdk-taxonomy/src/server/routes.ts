import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  lookupExtractionSchema,
  lookupPromptTemplate,
  activateTaxonomyVersion,
} from '../services/taxonomyService';

interface LookupSchemaQuery {
  tenant_id?: string;
  document_kind?: string;
}

interface LookupTemplateQuery {
  tenant_id?: string;
  purpose_tag?: string;
  name?: string;
}

interface ActivateBody {
  taxonomy_version_id: string;
}

interface VersionIdParams {
  taxonomy_version_id: string;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/taxonomy/health', async () => ({ sdk: 'sdk-taxonomy', status: 'ok' }));

  app.get<{ Querystring: LookupSchemaQuery }>(
    '/api/taxonomy/extraction-schemas',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query?.document_kind) {
        return reply.code(400).send({ success: false, error: 'Missing query param: document_kind' });
      }
      try {
        const row = await lookupExtractionSchema({
          tenant_id: req.query.tenant_id ?? null,
          document_kind: req.query.document_kind,
        });
        if (!row) return reply.code(404).send({ success: false, error: 'No active extraction schema for document_kind' });
        return reply.code(200).send({ success: true, data: row });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ success: false, error: 'Lookup failed' });
      }
    },
  );

  app.get<{ Querystring: LookupTemplateQuery }>(
    '/api/taxonomy/prompt-templates',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query?.purpose_tag) {
        return reply.code(400).send({ success: false, error: 'Missing query param: purpose_tag' });
      }
      try {
        const row = await lookupPromptTemplate({
          tenant_id: req.query.tenant_id ?? null,
          purpose_tag: req.query.purpose_tag,
          name: req.query.name,
        });
        if (!row) return reply.code(404).send({ success: false, error: 'No active prompt template for purpose_tag' });
        return reply.code(200).send({ success: true, data: row });
      } catch (err) {
        req.log.error(err);
        return reply.code(500).send({ success: false, error: 'Lookup failed' });
      }
    },
  );

  app.post<{ Params: VersionIdParams; Body: ActivateBody }>(
    '/api/taxonomy/versions/:taxonomy_version_id/activate',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.taxonomy_version_id) {
        return reply.code(400).send({ success: false, error: 'Missing path param: taxonomy_version_id' });
      }
      const actor = req.auth?.sub ?? 'system';
      try {
        const result = await activateTaxonomyVersion({
          taxonomy_version_id: req.params.taxonomy_version_id,
          actor_id: actor,
        });
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('not found')) {
          return reply.code(404).send({ success: false, error: msg });
        }
        req.log.error(err);
        return reply.code(500).send({ success: false, error: 'Activation failed' });
      }
    },
  );
}
