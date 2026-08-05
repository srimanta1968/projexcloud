import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuthOrApiKeyForDomain } from '@projexlight/sdk-api-keys';

/**
 * Every route in this SDK accepts EITHER a six-layer JWT or a tenant-scoped
 * `pk_live_`/`pk_test_` API key. Machine callers (vertical apps calling the
 * platform server-to-server) previously had no way to authenticate here, and the
 * only workaround was to put a human's password in a service's environment.
 *
 * Key holders must carry the scope derived from the route: `assignment.<resource>.read`
 * for GET, `assignment.<resource>.write` otherwise, where <resource> is the path
 * segment after `assignment` (so POST /api/assignment/... maps predictably). JWT
 * callers are unaffected — scopes apply only to keys.
 *
 * Named `requireAuth` so the route definitions below read unchanged; it is the
 * combined guard, not sdk-identity's JWT-only one.
 */
const requireAuth = requireAuthOrApiKeyForDomain('assignment');
import { assignByTask, type AssignByTaskInput, type AssignStrategy } from '../services/assignmentEngine';
import { setWorkload } from '../services/workloadService';
import type { GeoPoint } from '../services/geofence';
// P16 · EP-379 — the enhancement surface. assign-by-task above is UNTOUCHED: everything
// below is additive, and a regression test proves the old contract byte for byte. A
// vertical already calling it must not have to change anything.
import {
  activateRuleSet, getDecision, listDecisions, listRuleSetVersions, publishRuleSet,
  route as routeSubject, RuleSetNotFound,
} from '../services/routingService';
import {
  accept, AssignmentNotFound, decline, getAssignment, getHistory, InvalidTransition,
  NoBackupDesignated, offer, reassign, ReasonRequired, sweepExpiredOffers,
} from '../services/lifecycleService';
import {
  getSimulationRun, listSimulationRuns, readRotationState, simulate,
} from '../services/simulationService';

const STRATEGIES: AssignStrategy[] = ['default', 'round_robin', 'fair_share'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HTTP surface for sdk-assignment (EP-335). Exposes the auto-assignment engine
 * so sdk-scheduling and lead routing consume one implementation rather than
 * duplicating the strategy selection. Tenant-scoped; every call requires auth.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/assignment/assign-by-task', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      task_id: string;
      tenant_id: string;
      location: GeoPoint;
      required_skills: string[];
      fallback_radius_km: number;
      persona_locations: Record<string, GeoPoint>;
      candidate_persona_ids: string[];
      strategy: AssignStrategy;
      pool_key: string;
    }>;

    if (!body.task_id || !body.tenant_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['task_id and tenant_id are required'] });
    }
    if (!body.location || typeof body.location.lat !== 'number' || typeof body.location.lng !== 'number') {
      return reply.code(400).send({ error: 'ValidationError', details: ['location {lat,lng} is required'] });
    }
    if (body.strategy && !STRATEGIES.includes(body.strategy)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['invalid strategy'] });
    }

    const input: AssignByTaskInput = {
      task_id: body.task_id,
      tenant_id: body.tenant_id,
      location: body.location,
      required_skills: body.required_skills ?? [],
      fallback_radius_km: body.fallback_radius_km,
      persona_locations: body.persona_locations,
      candidate_persona_ids: body.candidate_persona_ids,
      strategy: body.strategy,
      pool_key: body.pool_key,
    };

    try {
      const result = await assignByTask(input);
      return reply.code(201).send({ data: result });
    } catch (err) {
      // No eligible persona (empty pool / all at capacity) is a 409 — the task
      // stays queued for a later dispatcher pass, not a client input error.
      return reply.code(409).send({ error: 'NoEligiblePersona', message: (err as Error).message });
    }
  });

  // FR-ASN-3 workload upsert — the HTTP surface for the existing setWorkload
  // service. Lets dispatchers (and tests) provision a persona's capacity/skills/
  // availability via the API instead of a direct DB seed. Idempotent on
  // persona_id; open_tasks is dispatcher-owned and deliberately not settable.
  app.put<{
    Params: { persona_id: string };
    Body: Partial<{
      capacity_per_day: number;
      skills: string[];
      available_from: string;
      available_to: string;
    }>;
  }>('/api/assignment/workload/:persona_id', { preHandler: requireAuth }, async (req, reply) => {
    const { persona_id } = req.params;
    if (!persona_id || !UUID_RE.test(persona_id)) {
      return reply.code(400).send({ error: 'ValidationError', details: ['persona_id must be a UUID'] });
    }
    const body = req.body ?? {};
    try {
      const result = await setWorkload({
        persona_id,
        capacity_per_day: body.capacity_per_day,
        skills: body.skills,
        available_from: body.available_from ? new Date(body.available_from) : null,
        available_to: body.available_to ? new Date(body.available_to) : null,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return reply.code(500).send({ error: 'InternalError', message: (err as Error).message });
    }
  });

  /* ================================================ P16 · EP-379 additions */

  const fail = (reply: FastifyReply, status: number, code: string, message: string): void => {
    reply.code(status).send({
      error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : 'RequestRefused',
      code,
      details: [message],
    });
  };

  const tenantOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const claimed = req.auth?.tenant_id;
    const named =
      (typeof body.tenant_id === 'string' && body.tenant_id.trim()) ||
      (typeof query.tenant_id === 'string' && query.tenant_id.trim()) || '';
    if (claimed && named && named !== claimed) {
      fail(reply, 403, 'TENANT_MISMATCH', 'tenant_id does not match the authenticated tenant');
      return null;
    }
    const tenant_id = claimed || named;
    if (!tenant_id) { fail(reply, 400, 'VALIDATION_ERROR', 'tenant_id is required'); return null; }
    return tenant_id;
  };

  const wrap =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await handler(req, reply);
      } catch (err) {
        if (err instanceof AssignmentNotFound || err instanceof RuleSetNotFound) {
          fail(reply, 404, (err as unknown as { code: string }).code, (err as Error).message); return;
        }
        if (err instanceof ReasonRequired) { fail(reply, 400, err.code, err.message); return; }
        if (err instanceof InvalidTransition || err instanceof NoBackupDesignated) {
          fail(reply, 409, (err as unknown as { code: string }).code, (err as Error).message); return;
        }
        req.log.error(err);
        if (!reply.sent) {
          reply.code(500).send({ error: 'InternalError', code: 'INTERNAL_ERROR', details: [] });
        }
      }
    };

  /** Publish a rule-set version, or activate an existing one. Routing is DATA. */
  app.post('/api/assignment/routes', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.activate_version === 'number') {
      reply.code(200).send({
        data: await activateRuleSet({
          tenant_id, version: b.activate_version,
          name: typeof b.name === 'string' ? b.name : undefined,
        }),
      });
      return;
    }
    if (!b.rules || typeof b.rules !== 'object') {
      fail(reply, 400, 'VALIDATION_ERROR', 'rules (object) or activate_version (number) is required');
      return;
    }
    reply.code(201).send({
      data: await publishRuleSet({
        tenant_id,
        rules: b.rules as Parameters<typeof publishRuleSet>[0]['rules'],
        name: typeof b.name === 'string' ? b.name : undefined,
        published_by: typeof b.published_by === 'string' ? b.published_by : undefined,
        activate: b.activate === true,
      }),
    });
  }));

  app.get('/api/assignment/routes', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    reply.code(200).send({
      data: {
        versions: await listRuleSetVersions(
          tenant_id, typeof q.name === 'string' ? q.name : undefined),
      },
    });
  }));

  /** Route ONE subject and return the decision trace. */
  app.post('/api/assignment/route', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.subject_ref !== 'string' || !b.subject_ref.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'subject_ref is required'); return;
    }
    if (!Array.isArray(b.candidate_persona_ids) || b.candidate_persona_ids.length === 0) {
      fail(reply, 400, 'VALIDATION_ERROR', 'candidate_persona_ids must be a non-empty array');
      return;
    }
    const decision = await routeSubject({
      tenant_id,
      subject_ref: b.subject_ref.trim(),
      subject: (b.subject ?? {}) as Record<string, unknown>,
      candidate_persona_ids: b.candidate_persona_ids as string[],
      persona_specialties: b.persona_specialties as Record<string, string[]> | undefined,
      rule_set_name: typeof b.rule_set_name === 'string' ? b.rule_set_name : undefined,
      dry_run: b.dry_run === true,
    });
    // 200, not 201: routing ANSWERS a question. A REVIEW outcome is a successful answer
    // too — "this needs a human" is the decision, not a failure to decide.
    reply.code(200).send({ data: decision });
  }));

  app.get('/api/assignment/decisions', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.decision_id === 'string' && q.decision_id) {
      const one = await getDecision(tenant_id, q.decision_id);
      if (!one) {
        fail(reply, 404, 'ROUTING_DECISION_NOT_FOUND', `no decision ${q.decision_id}`); return;
      }
      reply.code(200).send({ data: one });
      return;
    }
    reply.code(200).send({
      data: {
        decisions: await listDecisions({
          tenant_id,
          subject_ref: typeof q.subject_ref === 'string' ? q.subject_ref : undefined,
          outcome: q.outcome as never,
          limit: Number(q.limit ?? 50) || 50,
        }),
      },
    });
  }));

  /** Offer a subject to a primary, with a backup and a manager. */
  app.post('/api/assignments', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.subject_ref !== 'string' || typeof b.primary_persona_id !== 'string') {
      fail(reply, 400, 'VALIDATION_ERROR', 'subject_ref and primary_persona_id are required');
      return;
    }
    if (typeof b.source_timestamp !== 'string' || Number.isNaN(Date.parse(b.source_timestamp))) {
      // Required, never defaulted to now: when the WORLD produced the subject is the
      // instant every SLA measures from, and quietly substituting "now" would restate a
      // six-hour-old subject as fresh.
      fail(reply, 400, 'VALIDATION_ERROR', 'source_timestamp (ISO-8601) is required'); return;
    }
    reply.code(201).send({
      data: await offer({
        tenant_id,
        subject_ref: b.subject_ref,
        source_timestamp: new Date(b.source_timestamp),
        primary_persona_id: b.primary_persona_id,
        backup_persona_id: typeof b.backup_persona_id === 'string' ? b.backup_persona_id : undefined,
        manager_persona_id:
          typeof b.manager_persona_id === 'string' ? b.manager_persona_id : undefined,
        acceptance_window_minutes:
          typeof b.acceptance_window_minutes === 'number' ? b.acceptance_window_minutes : undefined,
        routing_decision_id:
          typeof b.routing_decision_id === 'string' ? b.routing_decision_id : undefined,
        actor: typeof b.actor === 'string' ? b.actor : undefined,
        metadata: (b.metadata ?? undefined) as Record<string, unknown> | undefined,
      }),
    });
  }));

  app.get('/api/assignments/:record_id', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const { record_id } = req.params as { record_id: string };
    const record = await getAssignment(tenant_id, record_id);
    if (!record) { fail(reply, 404, 'ASSIGNMENT_NOT_FOUND', `no assignment ${record_id}`); return; }
    reply.code(200).send({ data: { ...record, history: await getHistory(tenant_id, record_id) } });
  }));

  app.post('/api/assignments/:record_id/accept', { preHandler: requireAuth },
    wrap(async (req, reply) => {
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      const { record_id } = req.params as { record_id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      reply.code(200).send({
        data: await accept({
          tenant_id, record_id,
          persona_id: typeof b.persona_id === 'string' ? b.persona_id : undefined,
          actor: typeof b.actor === 'string' ? b.actor : undefined,
        }),
      });
    }));

  app.post('/api/assignments/:record_id/decline', { preHandler: requireAuth },
    wrap(async (req, reply) => {
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      const { record_id } = req.params as { record_id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      // The reason is REQUIRED by the schema, not merely encouraged: "it bounced three
      // times" tells an operator nothing about why.
      reply.code(200).send({
        data: await decline({
          tenant_id, record_id,
          reason: typeof b.reason === 'string' ? b.reason : '',
          actor: typeof b.actor === 'string' ? b.actor : undefined,
        }),
      });
    }));

  app.post('/api/assignments/:record_id/reassign', { preHandler: requireAuth },
    wrap(async (req, reply) => {
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      const { record_id } = req.params as { record_id: string };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.to_persona_id !== 'string' || !b.to_persona_id) {
        fail(reply, 400, 'VALIDATION_ERROR', 'to_persona_id is required'); return;
      }
      reply.code(200).send({
        data: await reassign({
          tenant_id, record_id, to_persona_id: b.to_persona_id,
          reason: typeof b.reason === 'string' ? b.reason : '',
          actor: typeof b.actor === 'string' ? b.actor : undefined,
        }),
      });
    }));

  /** Hand over every offer whose acceptance window has run out. */
  app.post('/api/assignments/sweep', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    reply.code(200).send({
      data: await sweepExpiredOffers({
        tenant_id, limit: typeof b.limit === 'number' ? b.limit : undefined,
      }),
    });
  }));

  app.get('/api/assignment/rotation', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    // READ ONLY. Advancing the cursor from a read endpoint would skew the real rotation
    // for everybody who merely looked at it.
    reply.code(200).send({
      data: {
        cursors: await readRotationState({
          tenant_id,
          pool_key: typeof q.pool_key === 'string' ? q.pool_key : undefined,
          strategy: typeof q.strategy === 'string' ? q.strategy : undefined,
        }),
      },
    });
  }));

  /** Replay history against a candidate version. Side-effect free, and it proves it. */
  app.post('/api/assignment/simulate', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.candidate_version !== 'number') {
      fail(reply, 400, 'VALIDATION_ERROR', 'candidate_version (number) is required'); return;
    }
    if (!Array.isArray(b.candidate_persona_ids) || b.candidate_persona_ids.length === 0) {
      fail(reply, 400, 'VALIDATION_ERROR', 'candidate_persona_ids must be a non-empty array');
      return;
    }
    const report = await simulate({
      tenant_id,
      candidate_version: b.candidate_version,
      rule_set_name: typeof b.rule_set_name === 'string' ? b.rule_set_name : undefined,
      candidate_persona_ids: b.candidate_persona_ids as string[],
      persona_specialties: b.persona_specialties as Record<string, string[]> | undefined,
      limit: typeof b.limit === 'number' ? b.limit : undefined,
      skew_tolerance: typeof b.skew_tolerance === 'number' ? b.skew_tolerance : undefined,
    });
    // 200 on a POST because nothing was created — and the report carries the proof
    // (side_effects all zero), so a caller can verify the claim rather than trust it.
    reply.code(200).send({ data: report });
  }));

  /**
   * Re-open a cited run.
   *
   * A simulation_id nobody can resolve is not evidence, and this is the half that makes
   * it one: a routing change gets proposed on a simulation, approved weeks later and
   * questioned months after that.
   */
  app.get('/api/assignment/simulations/:simulation_id', { preHandler: requireAuth },
    wrap(async (req, reply) => {
      const tenant_id = tenantOf(req, reply);
      if (!tenant_id) return;
      const { simulation_id } = req.params as { simulation_id: string };
      if (!UUID_RE.test(simulation_id)) {
        fail(reply, 400, 'VALIDATION_ERROR', 'simulation_id must be a UUID'); return;
      }
      const run = await getSimulationRun(tenant_id, simulation_id);
      /*
       * 404, not 403, when the run belongs to somebody else — the query is already
       * tenant-scoped, so a foreign id and a never-issued one are indistinguishable
       * here BY DESIGN. Answering "forbidden" would confirm that a simulation with
       * that id exists somewhere, which is itself the leak.
       */
      if (!run) {
        fail(reply, 404, 'SIMULATION_NOT_FOUND', 'no simulation run with that id for this tenant');
        return;
      }
      reply.code(200).send({ data: run });
    }),
  );

  /** The list a reviewer opens before they know which run they want. */
  app.get('/api/assignment/simulations', { preHandler: requireAuth }, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;

    let candidate_version: number | undefined;
    if (q.candidate_version !== undefined && q.candidate_version !== '') {
      candidate_version = Number(q.candidate_version);
      if (!Number.isInteger(candidate_version)) {
        fail(reply, 400, 'VALIDATION_ERROR', 'candidate_version must be an integer'); return;
      }
    }

    const runs = await listSimulationRuns({
      tenant_id,
      rule_set_name: typeof q.rule_set_name === 'string' && q.rule_set_name ? q.rule_set_name : undefined,
      candidate_version,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    // An empty array, not a 404: a tenant that has run no simulations is a valid state,
    // not a missing resource.
    reply.code(200).send({ data: { runs } });
  }));
}
