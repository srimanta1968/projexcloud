import { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuthOrApiKeyForDomain } from '@projexlight/sdk-api-keys';

/**
 * Every route in this SDK accepts EITHER a six-layer JWT or a tenant-scoped
 * `pk_live_`/`pk_test_` API key. Machine callers (vertical apps calling the
 * platform server-to-server) previously had no way to authenticate here, and the
 * only workaround was to put a human's password in a service's environment.
 *
 * Key holders must carry the scope derived from the route: `sla.<resource>.read`
 * for GET, `sla.<resource>.write` otherwise, where <resource> is the path
 * segment after `sla` (so POST /api/sla/... maps predictably). JWT
 * callers are unaffected — scopes apply only to keys.
 *
 * Named `requireAuth` so the route definitions below read unchanged; it is the
 * combined guard, not sdk-identity's JWT-only one.
 */
const requireAuth = requireAuthOrApiKeyForDomain('sla');
import {
  createCalendar,
  getCalendar,
  listCalendars,
  CalendarNeverOpen,
  FixedOffsetTimezoneRejected,
  type WeekendRule,
  type WorkingWindow,
} from '../services/calendarService';
import {
  createPolicy,
  getPolicy,
  listPolicies,
  startClock,
  getClock,
  listClocks,
  pauseClock,
  resumeClock,
  reassignClock,
  satisfyClock,
  cancelClock,
  mergeClocks,
  elapsedBusinessMinutes,
  type ClockState,
  type PauseCondition,
  type SatisfactionContract,
} from '../services/clockService';
import {
  createRung,
  listRungs,
  setRungActive,
  runTick,
  listFirings,
  findAtRisk,
  type RungAudience,
  type RungSeverity,
} from '../services/ladderService';
import {
  runBreachScan,
  recordBreach,
  recordRecovery,
  getBreach,
  listBreaches,
  getAttainment,
  upsertBreachReason,
  listBreachReasons,
  openPendingSystemicIncidents,
  type AttainmentDimension,
} from '../services/breachService';

/**
 * sdk-sla Fastify routes (P16 · EP-376 · PCF-03-5).
 *
 * The shape of the surface follows the domain: calendars and policies are
 * configuration, a clock is one live promise, rungs are the ladder that watches
 * it, and breaches plus attainment are what you answer for afterwards.
 *
 * Status codes per MUST-54: the four collection-root creates return 201; every
 * verb that moves an existing clock (satisfy, pause, resume, reassign, cancel,
 * breach) returns 200 because it changes a resource rather than creating one; the
 * tick and the breach scan return 200 as commands; reads return 200.
 *
 * `at_risk` is NOT a stored clock state — the enum is running / paused /
 * satisfied / breached / cancelled. At-risk is a DERIVED view over live clocks
 * approaching their deadline, served by GET /api/sla/at-risk. Storing it would
 * mean a background job had to keep a column truthful minute by minute, and a
 * stale "at risk" flag is worse than none.
 *
 * Typed service errors carry their own status and code, and the mapper preserves
 * both: a caller must be able to tell SATISFACTION_EVIDENCE_INSUFFICIENT (send
 * better evidence) from PAUSE_REASON_NOT_ALLOWED (this policy forbids that pause)
 * from BREACH_REASON_REQUIRED (name the cause).
 */

interface DomainError {
  status: number;
  code: string;
  message: string;
}

function isDomainError(err: unknown): err is DomainError & Error {
  return (
    err instanceof Error
    && typeof (err as Partial<DomainError>).status === 'number'
    && typeof (err as Partial<DomainError>).code === 'string'
  );
}

function sendDomainError(reply: FastifyReply, err: unknown): unknown {
  // A calendar with no open minute, or a timezone that is really an offset, are
  // configuration mistakes rather than server faults — 422 with the detail.
  if (err instanceof FixedOffsetTimezoneRejected) {
    return reply.code(422).send({
      error: err.name, code: 'FIXED_OFFSET_TIMEZONE_REJECTED', message: err.message,
    });
  }
  if (err instanceof CalendarNeverOpen) {
    return reply.code(422).send({
      error: err.name, code: 'CALENDAR_NEVER_OPEN', message: err.message,
    });
  }
  if (!isDomainError(err)) throw err;
  const body: Record<string, unknown> = { error: err.name, code: err.code, message: err.message };
  // The missing-evidence list is the point of the 422 — without it the caller has
  // to guess which requirement it failed.
  const missing = (err as unknown as { missing?: string[] }).missing;
  if (Array.isArray(missing)) body.missing = missing;
  const allowed = (err as unknown as { allowed?: string[] }).allowed;
  if (Array.isArray(allowed)) body.allowed = allowed;
  const from = (err as unknown as { from?: string }).from;
  const to = (err as unknown as { to?: string }).to;
  if (from) body.from = from;
  if (to) body.to = to;
  return reply.code(err.status).send(body);
}

function validationError(reply: FastifyReply, message: string): unknown {
  return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', message });
}

const asInt = (v: string | undefined): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------- calendars */

  app.post('/api/sla/calendars', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      slug: string;
      name: string;
      timezone: string;
      working_windows: Record<string, WorkingWindow[]>;
      description: string | null;
      late_coverage_extension_minutes: number;
      weekend_rule: WeekendRule;
      holiday_dates: string[];
      metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.slug || !body.name || !body.timezone) {
      return validationError(reply, 'tenant_id, slug, name and timezone are required');
    }
    if (!body.working_windows || Object.keys(body.working_windows).length === 0) {
      return validationError(
        reply,
        'working_windows is required — a calendar with no open minute can never make a due date',
      );
    }
    try {
      const calendar = await createCalendar({
        tenant_id: body.tenant_id,
        slug: body.slug,
        name: body.name,
        timezone: body.timezone,
        working_windows: body.working_windows,
        description: body.description,
        late_coverage_extension_minutes: body.late_coverage_extension_minutes,
        weekend_rule: body.weekend_rule,
        holiday_dates: body.holiday_dates,
        metadata: body.metadata,
      });
      return reply.code(201).send({ data: { calendar } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; is_active?: string; limit?: string; offset?: string } }>(
    '/api/sla/calendars',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      const calendars = await listCalendars({
        tenant_id: req.query.tenant_id,
        is_active: req.query.is_active === undefined ? undefined : req.query.is_active === 'true',
        limit: asInt(req.query.limit),
        offset: asInt(req.query.offset),
      });
      return reply.code(200).send({ data: { calendars, count: calendars.length } });
    },
  );

  app.get<{ Params: { calendar_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sla/calendars/:calendar_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      try {
        const calendar = await getCalendar(req.query.tenant_id, req.params.calendar_id);
        return reply.code(200).send({ data: { calendar } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* --------------------------------------------------------- policies */

  app.post('/api/sla/policies', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      slug: string;
      name: string;
      subject_kind: string;
      duration_minutes: number;
      calendar_id: string;
      description: string | null;
      qualifying_predicate: Record<string, unknown>;
      pause_conditions: PauseCondition[];
      satisfaction_contract: SatisfactionContract;
      metadata: Record<string, unknown>;
    }>;
    if (
      !body.tenant_id || !body.slug || !body.name || !body.subject_kind
      || !body.calendar_id || !body.duration_minutes
    ) {
      return validationError(
        reply,
        'tenant_id, slug, name, subject_kind, duration_minutes and calendar_id are required',
      );
    }
    if (body.duration_minutes <= 0) {
      return validationError(reply, 'duration_minutes must be greater than zero');
    }
    try {
      const policy = await createPolicy({
        tenant_id: body.tenant_id,
        slug: body.slug,
        name: body.name,
        subject_kind: body.subject_kind,
        duration_minutes: body.duration_minutes,
        calendar_id: body.calendar_id,
        description: body.description,
        qualifying_predicate: body.qualifying_predicate,
        pause_conditions: body.pause_conditions,
        satisfaction_contract: body.satisfaction_contract,
        metadata: body.metadata,
      });
      return reply.code(201).send({ data: { policy } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{
    Querystring: { tenant_id?: string; subject_kind?: string; is_active?: string; limit?: string; offset?: string };
  }>('/api/sla/policies', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const policies = await listPolicies({
      tenant_id: req.query.tenant_id,
      subject_kind: req.query.subject_kind,
      is_active: req.query.is_active === undefined ? undefined : req.query.is_active === 'true',
      limit: asInt(req.query.limit),
      offset: asInt(req.query.offset),
    });
    return reply.code(200).send({ data: { policies, count: policies.length } });
  });

  app.get<{ Params: { policy_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sla/policies/:policy_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      try {
        const policy = await getPolicy(req.query.tenant_id, req.params.policy_id);
        return reply.code(200).send({ data: { policy } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* ------------------------------------------------------ ladder rungs */

  app.post<{ Params: { policy_id: string } }>(
    '/api/sla/policies/:policy_id/rungs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string;
        rung_index: number;
        action: string;
        offset_minutes: number;
        minutes_before_due: number;
        minutes_after_due: number;
        label: string | null;
        audience: RungAudience;
        severity: RungSeverity;
        action_config: Record<string, unknown>;
        remediation_hint: string | null;
        metadata: Record<string, unknown>;
      }>;
      if (!body.tenant_id || body.rung_index === undefined || !body.action) {
        return validationError(reply, 'tenant_id, rung_index and action are required');
      }
      try {
        const rung = await createRung({
          tenant_id: body.tenant_id,
          policy_id: req.params.policy_id,
          rung_index: body.rung_index,
          action: body.action,
          offset_minutes: body.offset_minutes,
          minutes_before_due: body.minutes_before_due,
          minutes_after_due: body.minutes_after_due,
          label: body.label,
          audience: body.audience,
          severity: body.severity,
          action_config: body.action_config,
          remediation_hint: body.remediation_hint,
          metadata: body.metadata,
        });
        return reply.code(201).send({ data: { rung } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.get<{
    Params: { policy_id: string };
    Querystring: { tenant_id?: string; include_inactive?: string };
  }>('/api/sla/policies/:policy_id/rungs', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const rungs = await listRungs({
      tenant_id: req.query.tenant_id,
      policy_id: req.params.policy_id,
      include_inactive: req.query.include_inactive === 'true',
    });
    return reply.code(200).send({ data: { rungs, count: rungs.length } });
  });

  app.patch<{ Params: { rung_id: string } }>(
    '/api/sla/rungs/:rung_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; is_active: boolean }>;
      if (!body.tenant_id || typeof body.is_active !== 'boolean') {
        return validationError(reply, 'tenant_id and is_active (boolean) are required');
      }
      try {
        const rung = await setRungActive({
          tenant_id: body.tenant_id, rung_id: req.params.rung_id, is_active: body.is_active,
        });
        return reply.code(200).send({ data: { rung } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* ----------------------------------------------------------- clocks */

  app.post('/api/sla/clocks', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      policy_id: string;
      subject_ref: string;
      source_timestamp: string;
      owner_ref: string | null;
      metadata: Record<string, unknown>;
      actor_id: string;
    }>;
    if (!body.tenant_id || !body.policy_id || !body.subject_ref) {
      return validationError(reply, 'tenant_id, policy_id and subject_ref are required');
    }
    try {
      const result = await startClock({
        tenant_id: body.tenant_id,
        policy_id: body.policy_id,
        subject_ref: body.subject_ref,
        source_timestamp: body.source_timestamp,
        owner_ref: body.owner_ref,
        metadata: body.metadata,
        actor_id: body.actor_id,
      });
      // A live clock already running for this policy and subject is returned as-is
      // with 200: starting a second one would double-count the promise and fire the
      // ladder twice, so the honest answer is "here is the one you already have".
      return reply.code(result.created ? 201 : 200).send({
        data: { clock: result.clock, created: result.created },
      });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{
    Querystring: {
      tenant_id?: string; subject_ref?: string; policy_id?: string; state?: ClockState;
      owner_ref?: string; limit?: string; offset?: string;
    };
  }>('/api/sla/clocks', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const clocks = await listClocks({
      tenant_id: req.query.tenant_id,
      subject_ref: req.query.subject_ref,
      policy_id: req.query.policy_id,
      state: req.query.state,
      owner_ref: req.query.owner_ref,
      limit: asInt(req.query.limit),
      offset: asInt(req.query.offset),
    });
    return reply.code(200).send({ data: { clocks, count: clocks.length } });
  });

  app.get<{ Params: { clock_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sla/clocks/:clock_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      try {
        const clock = await getClock(req.query.tenant_id, req.params.clock_id);
        const policy = await getPolicy(req.query.tenant_id, clock.policy_id);
        const calendar = await getCalendar(req.query.tenant_id, policy.calendar_id);
        // Elapsed comes back with the clock because "how long has this been
        // waiting, in the hours we are actually open" is the question every caller
        // asks next, and computing it from the raw columns needs the calendar.
        const elapsed_business_minutes = Math.round(await elapsedBusinessMinutes(clock, calendar));
        return reply.code(200).send({
          data: {
            clock,
            elapsed_business_minutes,
            duration_minutes: policy.duration_minutes,
            is_overdue: Date.parse(clock.due_at as unknown as string) <= Date.now()
              && (clock.state === 'running' || clock.state === 'paused'),
          },
        });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/satisfy',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string;
        evidence_ref: string | null;
        evidence_kind: string | null;
        evidence_count: number;
        satisfied_by: string | null;
        actor_id: string;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        const clock = await satisfyClock({
          tenant_id: body.tenant_id,
          clock_id: req.params.clock_id,
          evidence_ref: body.evidence_ref,
          evidence_kind: body.evidence_kind,
          evidence_count: body.evidence_count,
          satisfied_by: body.satisfied_by,
          actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: { clock } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/pause',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; reason: string; actor_id: string }>;
      if (!body.tenant_id || !body.reason) {
        return validationError(reply, 'tenant_id and reason are required');
      }
      try {
        const clock = await pauseClock({
          tenant_id: body.tenant_id, clock_id: req.params.clock_id,
          reason: body.reason, actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: { clock } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/resume',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; actor_id: string }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      try {
        const clock = await resumeClock({
          tenant_id: body.tenant_id, clock_id: req.params.clock_id, actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: { clock } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/reassign',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; owner_ref: string; reason: string; actor_id: string;
      }>;
      if (!body.tenant_id || !body.owner_ref) {
        return validationError(reply, 'tenant_id and owner_ref are required');
      }
      try {
        const clock = await reassignClock({
          tenant_id: body.tenant_id, clock_id: req.params.clock_id,
          owner_ref: body.owner_ref, reason: body.reason, actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: { clock } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ tenant_id: string; reason: string; actor_id: string }>;
      if (!body.tenant_id || !body.reason) {
        return validationError(reply, 'tenant_id and reason are required');
      }
      try {
        const clock = await cancelClock({
          tenant_id: body.tenant_id, clock_id: req.params.clock_id,
          reason: body.reason, actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: { clock } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post('/api/sla/clocks/merge', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; surviving_clock_id: string; merged_clock_id: string; actor_id: string;
    }>;
    if (!body.tenant_id || !body.surviving_clock_id || !body.merged_clock_id) {
      return validationError(
        reply, 'tenant_id, surviving_clock_id and merged_clock_id are required',
      );
    }
    try {
      const result = await mergeClocks({
        tenant_id: body.tenant_id,
        surviving_clock_id: body.surviving_clock_id,
        merged_clock_id: body.merged_clock_id,
        actor_id: body.actor_id,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{ Params: { clock_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sla/clocks/:clock_id/firings',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      const firings = await listFirings(req.query.tenant_id, req.params.clock_id);
      return reply.code(200).send({ data: { firings, count: firings.length } });
    },
  );

  /* ------------------------------------------------- tick and scanning */

  app.post('/api/sla/tick', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; as_of: string; limit: number; actor_id: string;
    }>;
    if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
    try {
      // Safe to call as often as you like, from as many callers as you like: each
      // rung is claimed through a unique ledger row, so duplicates stand down.
      const result = await runTick({
        tenant_id: body.tenant_id,
        asOf: body.as_of ? new Date(body.as_of) : undefined,
        limit: body.limit,
        actor_id: body.actor_id,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.post('/api/sla/breach-scan', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; as_of: string; limit: number; actor_id: string;
    }>;
    if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
    try {
      const result = await runBreachScan({
        tenant_id: body.tenant_id,
        asOf: body.as_of ? new Date(body.as_of) : undefined,
        limit: body.limit,
        actor_id: body.actor_id,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{
    Querystring: {
      tenant_id?: string; within_minutes?: string; include_overdue?: string; limit?: string;
    };
  }>('/api/sla/at-risk', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    try {
      const at_risk = await findAtRisk({
        tenant_id: req.query.tenant_id,
        within_minutes: asInt(req.query.within_minutes),
        include_overdue: req.query.include_overdue === undefined
          ? undefined
          : req.query.include_overdue === 'true',
        limit: asInt(req.query.limit),
      });
      return reply.code(200).send({ data: { at_risk, count: at_risk.length } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  /* --------------------------------------------------------- breaches */

  app.post<{ Params: { clock_id: string } }>(
    '/api/sla/clocks/:clock_id/breach',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string;
        reason_code: string;
        reason_detail: string | null;
        source_ref: string | null;
        is_systemic: boolean;
        systemic_group_key: string;
        recovery_action: string | null;
        recovered_by: string | null;
        recorded_by: string | null;
        metadata: Record<string, unknown>;
        actor_id: string;
      }>;
      if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
      // reason_code is NOT checked here: the service raises the typed 422
      // BREACH_REASON_REQUIRED so the refusal reads the same whichever way the
      // call arrives, and says why rather than just "invalid body".
      try {
        const result = await recordBreach({
          tenant_id: body.tenant_id,
          clock_id: req.params.clock_id,
          reason_code: body.reason_code as string,
          reason_detail: body.reason_detail,
          source_ref: body.source_ref,
          is_systemic: body.is_systemic,
          systemic_group_key: body.systemic_group_key,
          recovery_action: body.recovery_action,
          recovered_by: body.recovered_by,
          recorded_by: body.recorded_by,
          metadata: body.metadata,
          actor_id: body.actor_id,
        });
        return reply.code(200).send({ data: result });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.get<{
    Querystring: {
      tenant_id?: string; policy_id?: string; owner_ref?: string; reason_code?: string;
      from?: string; to?: string; unrecovered_only?: string; limit?: string; offset?: string;
    };
  }>('/api/sla/breaches', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
    const breaches = await listBreaches({
      tenant_id: req.query.tenant_id,
      policy_id: req.query.policy_id,
      owner_ref: req.query.owner_ref,
      reason_code: req.query.reason_code,
      from: req.query.from,
      to: req.query.to,
      unrecovered_only: req.query.unrecovered_only === 'true',
      limit: asInt(req.query.limit),
      offset: asInt(req.query.offset),
    });
    return reply.code(200).send({ data: { breaches, count: breaches.length } });
  });

  app.get<{ Params: { breach_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/sla/breaches/:breach_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      try {
        const breach = await getBreach(req.query.tenant_id, req.params.breach_id);
        return reply.code(200).send({ data: { breach } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { breach_id: string } }>(
    '/api/sla/breaches/:breach_id/recovery',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{
        tenant_id: string; recovery_action: string; recovered_by: string | null;
      }>;
      if (!body.tenant_id || !body.recovery_action) {
        return validationError(reply, 'tenant_id and recovery_action are required');
      }
      try {
        const breach = await recordRecovery({
          tenant_id: body.tenant_id,
          breach_id: req.params.breach_id,
          recovery_action: body.recovery_action,
          recovered_by: body.recovered_by,
        });
        return reply.code(200).send({ data: { breach } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post('/api/sla/breach-reasons', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; code: string; label: string | null; category: string | null;
    }>;
    if (!body.tenant_id || !body.code) {
      return validationError(reply, 'tenant_id and code are required');
    }
    try {
      // Upsert, so 200 rather than 201 per MUST-54.
      const reason = await upsertBreachReason({
        tenant_id: body.tenant_id, code: body.code,
        label: body.label, category: body.category,
      });
      return reply.code(200).send({ data: { reason } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/sla/breach-reasons',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) return validationError(reply, 'tenant_id query param required');
      const reasons = await listBreachReasons(req.query.tenant_id);
      return reply.code(200).send({ data: { reasons, count: reasons.length } });
    },
  );

  app.post('/api/sla/systemic-incidents/open-pending', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ tenant_id: string; limit: number }>;
    if (!body.tenant_id) return validationError(reply, 'tenant_id is required');
    try {
      const result = await openPendingSystemicIncidents({
        tenant_id: body.tenant_id, limit: body.limit,
      });
      return reply.code(200).send({ data: result });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });

  /* ------------------------------------------------------- attainment */

  app.get<{
    Querystring: {
      tenant_id?: string; from?: string; to?: string; policy_id?: string; owner_ref?: string;
      subject_kind?: string; dimensions?: string; max_clocks?: string;
    };
  }>('/api/sla/attainment', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id || !req.query.from || !req.query.to) {
      return validationError(reply, 'tenant_id, from and to query params are required');
    }
    const allowed: AttainmentDimension[] = ['source', 'owner', 'day', 'hour', 'reason', 'policy'];
    let dimensions: AttainmentDimension[] | undefined;
    if (req.query.dimensions) {
      const asked = req.query.dimensions.split(',').map((d) => d.trim()).filter(Boolean);
      const unknown = asked.filter((d) => !allowed.includes(d as AttainmentDimension));
      // An unrecognised dimension is refused rather than dropped: silently
      // returning fewer breakdowns than were asked for reads as "no data".
      if (unknown.length > 0) {
        return validationError(
          reply,
          `unknown dimension(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`,
        );
      }
      dimensions = asked as AttainmentDimension[];
    }
    try {
      const report = await getAttainment({
        tenant_id: req.query.tenant_id,
        from: req.query.from,
        to: req.query.to,
        policy_id: req.query.policy_id,
        owner_ref: req.query.owner_ref,
        subject_kind: req.query.subject_kind,
        dimensions,
        max_clocks: asInt(req.query.max_clocks),
      });
      return reply.code(200).send({ data: { attainment: report } });
    } catch (err) {
      return sendDomainError(reply, err);
    }
  });
}
