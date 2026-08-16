import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import type { Decision } from '@projexlight/sdk-approval';
import { explain, resolveIdentityContext } from '../services/resolverService';
import { resolveTraits } from '../services/matchService';
import {
  CandidateLinkNotFoundError,
  MergeNotFoundError,
  adjudicateCandidate,
  enqueueStewardReview,
  getEmpiMetrics,
  mergeRecords,
  queryCandidateLinksByBand,
  unmergeRecords,
  type ConfidenceBand,
} from '../services/empiService';

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

  /*
   * POST /api/resolver/match — traits in, a person or a case out.
   *
   * THE ROUTE THE MANIFEST HAS ALWAYS DESCRIBED. `sdk-capability.json` advertised
   * "/api/resolver/resolve: resolve a signal bundle to the most-likely persona",
   * which is this operation; the route of that name reads an identity context for
   * a person_id you already have. Consumers built against the description, sent
   * traits, and got 400 — while `empi.candidate_link` stayed empty because nothing
   * in the platform ever raised one. Added alongside rather than by changing
   * /resolve, whose existing callers pass person_id and want the context.
   */
  app.post('/api/resolver/match', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      traits: Record<string, string>;
      person_id: string;
      app_id: string;
      source_record_id: string;
    }>;

    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;

    const traits = body.traits ?? {};
    // A bundle with nothing to match on cannot answer "which person is this",
    // and answering `no_match` for it would report an absence we never looked
    // for. 400, so the caller learns their extraction produced nothing.
    const hasSignal = ['name', 'email', 'phone', 'dob', 'address', 'external_id'].some(
      (key) => typeof traits[key] === 'string' && traits[key].trim() !== '',
    );
    if (!hasSignal) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: ['traits must carry at least one of name, email, phone, dob, address, external_id'],
      });
    }

    try {
      const result = await resolveTraits({
        tenant_id,
        app_id: body.app_id ?? req.auth?.app_id ?? undefined,
        source_record_id: body.source_record_id,
        person_id: body.person_id,
        traits,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
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

  // ── P10/E6 — Healthcare EMPI / probabilistic MDM ─────────────────────────
  const personaOf = (req: { auth?: { primary_persona_id?: string | null; sub?: string } }): string =>
    req.auth?.primary_persona_id ?? req.auth?.sub ?? '';

  /**
   * Tenant comes from the CREDENTIAL, never from the query or body. EMPI rows
   * carry person ids paired with the provenance explaining why two humans were
   * thought to be the same, so a caller-supplied tenant would let anyone read
   * anyone's. Answers 400 when the credential carries no tenant rather than
   * falling back to an unscoped read.
   */
  const tenantOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const tenant_id = req.auth?.tenant_id;
    if (!tenant_id) {
      reply.code(400).send({
        error: 'ValidationError',
        details: ['This credential carries no tenant context'],
      });
      return null;
    }
    return tenant_id;
  };

  /**
   * Maps a service error onto a status. An id that does not resolve is 404, not
   * 500: it is the caller naming something absent, and answering 500 both sends
   * an integrator debugging a server fault that never happened and — because a
   * 5xx is retryable and a 404 is not — makes their client retry a request that
   * can never succeed.
   */
  const sendEmpiError = (reply: FastifyReply, err: unknown): void => {
    if (reply.sent) return;
    if (err instanceof CandidateLinkNotFoundError || err instanceof MergeNotFoundError) {
      reply.code(404).send({ error: err.code, details: [(err as Error).message] });
      return;
    }
    reply.code(500).send({ error: 'InternalError', details: [(err as Error).message] });
  };

  // GET /api/empi/candidate-links?band=high|medium|low&status=open — query by band.
  app.get<{ Querystring: { band?: ConfidenceBand; status?: string; min?: string; max?: string; limit?: string } }>(
    '/api/empi/candidate-links',
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = req.query ?? {};
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      try {
        const links = await queryCandidateLinksByBand({
          tenant_id,
          band: q.band,
          status: q.status as 'open' | 'merged' | 'rejected' | 'superseded' | undefined,
          min: q.min ? parseFloat(q.min) : undefined,
          max: q.max ? parseFloat(q.max) : undefined,
          limit: q.limit ? parseInt(q.limit, 10) : undefined,
        });
        return reply.code(200).send({ data: { candidate_links: links } });
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    },
  );

  // POST /api/empi/candidate-links/:link_id/steward-review — queue for steward.
  app.post<{ Params: { link_id: string }; Body: { route_id?: string; tenant_id?: string } }>(
    '/api/empi/candidate-links/:link_id/steward-review',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      // Deliberately NOT b.tenant_id: a body-supplied tenant would let a caller
      // queue another tenant's link for review under their own approval route.
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      if (!b.route_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['route_id is required'] });
      }
      try {
        const result = await enqueueStewardReview(req.params.link_id, {
          tenant_id,
          route_id: b.route_id,
          steward_persona_id: personaOf(req),
        });
        return reply.code(201).send({ data: result });
      } catch (err) {
        req.log.error(err);
        sendEmpiError(reply, err);
      }
    },
  );

  // POST /api/empi/candidate-links/:link_id/adjudicate — steward decision.
  app.post<{ Params: { link_id: string }; Body: { step_id?: string; decision?: Decision; reason?: string } }>(
    '/api/empi/candidate-links/:link_id/adjudicate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.step_id || (b.decision !== 'approve' && b.decision !== 'reject')) {
        return reply.code(400).send({ error: 'ValidationError', details: ['step_id and decision (approve|reject) are required'] });
      }
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      try {
        const result = await adjudicateCandidate(req.params.link_id, tenant_id, b.step_id, personaOf(req), b.decision, b.reason);
        return reply.code(200).send({ data: result });
      } catch (err) {
        req.log.error(err);
        sendEmpiError(reply, err);
      }
    },
  );

  // POST /api/empi/merges — direct reversible merge (steward/ops).
  app.post<{ Body: { surviving_person_id?: string; merged_person_id?: string; link_id?: string; reason?: string } }>(
    '/api/empi/merges',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.surviving_person_id || !b.merged_person_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['surviving_person_id, merged_person_id are required'] });
      }
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      try {
        const merge = await mergeRecords({
          tenant_id,
          surviving_person_id: b.surviving_person_id,
          merged_person_id: b.merged_person_id,
          link_id: b.link_id,
          decided_by: personaOf(req),
          reason: b.reason,
        });
        return reply.code(201).send({ data: { merge } });
      } catch (err) {
        req.log.error(err);
        sendEmpiError(reply, err);
      }
    },
  );

  // POST /api/empi/merges/:merge_id/unmerge — compensating reversal.
  app.post<{ Params: { merge_id: string }; Body: { reason?: string } }>(
    '/api/empi/merges/:merge_id/unmerge',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      try {
        const compensation = await unmergeRecords(req.params.merge_id, tenant_id, {
          decided_by: personaOf(req),
          reason: req.body?.reason,
        });
        return reply.code(200).send({ data: { merge: compensation } });
      } catch (err) {
        req.log.error(err);
        sendEmpiError(reply, err);
      }
    },
  );

  // GET /api/empi/metrics — calibration (ECE) + unresolved/reversal metrics.
  app.get('/api/empi/metrics', { preHandler: requireAuth }, async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    try {
      const metrics = await getEmpiMetrics(tenant_id);
      return reply.code(200).send({ data: { metrics } });
    } catch (err) {
      req.log.error(err);
      if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
    }
  });
}
