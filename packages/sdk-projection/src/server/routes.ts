import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  listSurvivorshipRules,
  putSurvivorshipRules,
  validateCriteria,
} from '../services/survivorshipRuleService';
import { explainProjection, listAssertions } from '../services/explainedProjectionService';
import {
  replaySubject,
  replayTenant,
  retractAndReplay,
  supersedeAndReplay,
  type ReplayTrigger,
} from '../services/replayService';

const REPLAY_TRIGGERS: ReplayTrigger[] = ['manual', 'retraction', 'supersede', 'rule_change', 'backfill'];

/**
 * sdk-projection survivorship + explained-projection routes (P16 · EP-382). All
 * tenant-authed — these read and write a tenant's precedence policy and its subject data.
 */

function badRequest(reply: any, details: string[]) {
  return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // PUT /api/projection/survivorship-rules
  // -------------------------------------------------------------------------
  app.put('/api/projection/survivorship-rules', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; attribute: string; criteria: unknown; updated_by: string;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (body.criteria === undefined) missing.push('criteria is required');
    if (missing.length) return badRequest(reply, missing);

    // Validated here as well as in the service so a malformed rule set is refused at write
    // time with the specific problem named, rather than producing a wrong winner later.
    const errors = validateCriteria(body.criteria);
    if (errors.length) return badRequest(reply, errors);

    const ruleSet = await putSurvivorshipRules({
      tenant_id: body.tenant_id!,
      attribute: body.attribute,
      criteria: body.criteria as never,
      updated_by: body.updated_by,
    });
    // Upsert → 200, not 201: the same call creates or replaces the tenant's rule set.
    return reply.code(200).send({ data: { rule_set: ruleSet } });
  });

  // -------------------------------------------------------------------------
  // GET /api/projection/survivorship-rules
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/projection/survivorship-rules',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query?.tenant_id) return badRequest(reply, ['tenant_id query param required']);
      const rule_sets = await listSurvivorshipRules(req.query.tenant_id);
      // Platform rows are returned alongside tenant ones, each tagged with its source, so
      // a tenant can see what it is overriding rather than only what it has overridden.
      return reply.code(200).send({ data: { rule_sets } });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projection/subject/:subject_ref/explained
  // -------------------------------------------------------------------------
  app.get<{
    Params: { subject_ref: string };
    Querystring: { tenant_id?: string; attributes?: string; include_retracted?: string; include_all_assertions?: string };
  }>(
    '/api/projection/subject/:subject_ref/explained',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query?.tenant_id) return badRequest(reply, ['tenant_id query param required']);
      const subject_ref = decodeURIComponent(req.params.subject_ref);
      if (!subject_ref.trim()) return badRequest(reply, ['subject_ref is required']);

      const projection = await explainProjection({
        tenant_id: req.query.tenant_id,
        subject_ref,
        attributes: req.query.attributes ? req.query.attributes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        include_retracted: req.query.include_retracted === 'true',
      });

      // Opt-in rather than always: the explained view already carries every assertion that
      // took part, and this adds the ones excluded from the contest (retracted/rejected)
      // for callers auditing why something is not even competing.
      const all_assertions = req.query.include_all_assertions === 'true'
        ? await listAssertions({ tenant_id: req.query.tenant_id, subject_ref, include_retracted: true })
        : undefined;

      return reply.code(200).send({
        data: { projection, ...(all_assertions ? { all_assertions } : {}) },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projection/replay
  // -------------------------------------------------------------------------
  app.post('/api/projection/replay', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; subject_ref: string; trigger: ReplayTrigger; reason: string;
      retract_assertion_id: string; supersede_assertion_id: string; superseded_by: string;
      scope: 'subject' | 'tenant'; limit: number;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (body.trigger && !REPLAY_TRIGGERS.includes(body.trigger)) {
      missing.push(`trigger must be one of: ${REPLAY_TRIGGERS.join(', ')}`);
    }
    if (body.supersede_assertion_id && !body.superseded_by) {
      missing.push('superseded_by is required when supersede_assertion_id is given');
    }
    if (body.supersede_assertion_id && body.supersede_assertion_id === body.superseded_by) {
      missing.push('an assertion cannot supersede itself');
    }
    const scope = body.scope ?? 'subject';
    if (scope === 'subject' && !body.subject_ref && !body.retract_assertion_id && !body.supersede_assertion_id) {
      missing.push('subject_ref, retract_assertion_id or supersede_assertion_id is required for scope=subject');
    }
    if (missing.length) return badRequest(reply, missing);

    // Retract/supersede resolve their own subject and replay it, so a caller never has to
    // know which subject an assertion belonged to in order to propagate the change.
    if (body.retract_assertion_id) {
      const out = await retractAndReplay({
        tenant_id: body.tenant_id!,
        assertion_id: body.retract_assertion_id,
        reason: body.reason,
      });
      if (!out.retracted) {
        return reply.code(404).send({ error: 'NotFound', code: 'ASSERTION_NOT_FOUND' });
      }
      return reply.code(200).send({ data: out });
    }

    if (body.supersede_assertion_id) {
      const out = await supersedeAndReplay({
        tenant_id: body.tenant_id!,
        assertion_id: body.supersede_assertion_id,
        superseded_by: body.superseded_by!,
        reason: body.reason,
      });
      if (!out.superseded) {
        return reply.code(404).send({ error: 'NotFound', code: 'ASSERTION_NOT_FOUND' });
      }
      return reply.code(200).send({ data: out });
    }

    if (scope === 'tenant') {
      const out = await replayTenant({
        tenant_id: body.tenant_id!,
        trigger: body.trigger ?? 'rule_change',
        reason: body.reason,
        limit: body.limit,
      });
      // `remaining` is returned rather than the sweep running unbounded — the caller
      // decides whether to continue, instead of a rule edit becoming an open-ended job.
      return reply.code(200).send({ data: out });
    }

    const out = await replaySubject({
      tenant_id: body.tenant_id!,
      subject_ref: body.subject_ref!,
      trigger: body.trigger ?? 'manual',
      reason: body.reason,
    });
    // An action endpoint, and a replay is idempotent, so 200 on both the first call and
    // every repeat — a repeat is expected, not an error.
    return reply.code(200).send({ data: out });
  });
}
