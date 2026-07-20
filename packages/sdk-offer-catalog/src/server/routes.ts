import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createOffer,
  getOffer,
  createOfferVersion,
  getOfferVersion,
  activateOfferVersion,
  resolveCurrentVersion,
  listOfferVersions,
  requestPublishApproval,
  recordPublishDecision,
  OfferVersionNotFoundError,
  PublishNotApprovedError,
} from '../services/offerCatalogService';

/**
 * sdk-offer-catalog Fastify routes (P15·E1, TK-3641). Offer + version create,
 * activate/publish (atomic demote-prior + promote), and resolve-current-with-fallback.
 * All tenant-authed; tenant_id carried in the body/query as in the sibling SDKs.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/offers', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; name: string; slug: string; description: string; owner_persona_id: string }>;
    if (!body.tenant_id || !body.name || !body.slug) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, name and slug are required'] });
    }
    try {
      const offer = await createOffer({
        tenantId: body.tenant_id, name: body.name, slug: body.slug, description: body.description, ownerPersonaId: body.owner_persona_id,
      });
      return reply.code(201).send({ data: { offer } });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Conflict', details: ['an offer with this slug already exists'] });
      throw err;
    }
  });

  app.get<{ Params: { offer_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/offers/:offer_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const offer = await getOffer(req.query.tenant_id, req.params.offer_id);
      if (!offer) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { offer } });
    },
  );

  app.post<{ Params: { offer_id: string } }>(
    '/api/offers/:offer_id/versions', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; version: string; title: string; price: number; currency: string; parent_version_id: string; body: Record<string, unknown> }>;
      if (!body.tenant_id || !body.version) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and version are required'] });
      }
      try {
        const version = await createOfferVersion({
          tenantId: body.tenant_id, offerId: req.params.offer_id, version: body.version, title: body.title,
          price: body.price, currency: body.currency, parentVersionId: body.parent_version_id, body: body.body,
        });
        return reply.code(201).send({ data: { version } });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Conflict', details: ['this version already exists for the offer'] });
        throw err;
      }
    },
  );

  app.get<{ Params: { offer_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/offers/:offer_id/versions', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const versions = await listOfferVersions(req.query.tenant_id, req.params.offer_id);
      return reply.code(200).send({ data: { versions } });
    },
  );

  // Activate/publish a version: atomically demote the prior live + promote this one.
  app.post<{ Params: { offer_id: string; version_id: string } }>(
    '/api/offers/:offer_id/versions/:version_id/activate', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const version = await activateOfferVersion(body.tenant_id, req.params.offer_id, req.params.version_id);
        return reply.code(200).send({ data: { version } });
      } catch (err) {
        if (err instanceof OfferVersionNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['offer version not found'] });
        if (err instanceof PublishNotApprovedError) return reply.code(409).send({ error: 'PublishNotApproved', details: [(err as Error).message] });
        throw err;
      }
    },
  );

  // Publish gate (TK-3642): file an approval request (subject = offer_version_id).
  app.post<{ Params: { offer_id: string; version_id: string } }>(
    '/api/offers/:offer_id/versions/:version_id/publish-request', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const result = await requestPublishApproval(body.tenant_id, req.params.offer_id, req.params.version_id);
        return reply.code(201).send({ data: { publish: result } });
      } catch (err) {
        if (err instanceof OfferVersionNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['offer version not found'] });
        throw err;
      }
    },
  );

  // Record the approval decision (from sdk-approval): approved | rejected.
  app.post<{ Params: { offer_id: string; version_id: string } }>(
    '/api/offers/:offer_id/versions/:version_id/publish-decision', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; decision?: 'approved' | 'rejected' };
      if (!body.tenant_id || !body.decision) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and decision are required'] });
      if (body.decision !== 'approved' && body.decision !== 'rejected') {
        return reply.code(400).send({ error: 'ValidationError', details: ['decision must be approved or rejected'] });
      }
      try {
        const version = await recordPublishDecision(body.tenant_id, req.params.version_id, body.decision);
        return reply.code(200).send({ data: { version } });
      } catch (err) {
        if (err instanceof OfferVersionNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['offer version not found'] });
        throw err;
      }
    },
  );

  // Resolve the current version with fallback (live -> beta -> most recent draft).
  app.get<{ Params: { offer_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/offers/:offer_id/current', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const resolved = await resolveCurrentVersion(req.query.tenant_id, req.params.offer_id);
      return reply.code(200).send({ data: resolved });
    },
  );

  // Fetch one version by id.
  app.get<{ Params: { offer_id: string; version_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/offers/:offer_id/versions/:version_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const version = await getOfferVersion(req.query.tenant_id, req.params.version_id);
      if (!version) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { version } });
    },
  );
}
