import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  findEligible,
  upsertSchedule,
  listSchedules,
  type WeekdayWindow,
} from '../services/eligibilityService';
// UnknownTimezone covers both an unresolvable zone and a fixed UTC offset: the
// zone validator refuses an offset because it cannot express DST, and both
// arrive here as the same class.
import { UnknownTimezone, FixedOffsetTimezone } from '../services/timezone';
import {
  addRosterEntry,
  resolveOnCall,
  listRoster,
} from '../services/onCallService';
import {
  upsertCapacityPolicy,
  listCapacityPolicies,
  CapacityPolicySubjectError,
} from '../services/capacityService';
import {
  CoverageValidationError,
  designateBackup,
  listBackups,
  listHolidayCalendars,
  listTimeOff,
  recordTimeOff,
  setPresence,
  upsertHolidayCalendar,
  type PresenceSource,
  type PresenceStatus,
  type TimeOffKind,
} from '../services/presenceService';
import { detectGaps, GapWindowError } from '../services/gapService';

/**
 * HTTP surface for sdk-coverage.
 *
 * ERROR SHAPES ARE DELIBERATE and match the api_definitions written before these
 * handlers existed:
 *   400 — the request is missing something structural (no tenant_id, no rotation).
 *   422 — the request is well-formed but the CONTENT is refused: an unresolvable
 *         timezone, an inverted interval, a persona backing themselves up. These
 *         are the cases where a caller has to change a value rather than a shape,
 *         and collapsing them into 400 makes that indistinguishable.
 *
 * Guarded with sdk-identity's requireAuth. The gateway's default-deny gate also
 * accepts a scoped API key on these routes, deriving coverage.<resource>.<action>
 * from the path — so a machine caller reaches them without any change here.
 */

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const claimed = req.auth?.tenant_id;
  const named =
    (typeof body.tenant_id === 'string' && body.tenant_id.trim()) ||
    (typeof query.tenant_id === 'string' && query.tenant_id.trim()) ||
    '';

  // The credential wins when it carries a tenant; a payload naming a different
  // one is refused rather than silently preferred either way.
  if (claimed && named && named !== claimed) {
    reply.code(403).send({
      error: 'Forbidden',
      details: ['tenant_id does not match the authenticated tenant'],
    });
    return null;
  }
  const tenant_id = claimed || named;
  if (!tenant_id) {
    reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
    return null;
  }
  return tenant_id;
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CoverageValidationError(`${field} must be an ISO-8601 instant`);
  }
  return new Date(value);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { preHandler: requireAuth };

  /** Maps a domain error to the status its api_definition promises. */
  const wrap =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await handler(req, reply);
      } catch (err) {
        if (
          err instanceof CoverageValidationError ||
          err instanceof UnknownTimezone ||
          err instanceof FixedOffsetTimezone ||
          err instanceof CapacityPolicySubjectError ||
          err instanceof GapWindowError
        ) {
          reply.code(422).send({ error: 'UnprocessableEntity', details: [(err as Error).message] });
          return;
        }
        req.log.error(err);
        if (!reply.sent) reply.code(500).send({ error: 'InternalError' });
      }
    };

  /* ------------------------------------------------------- schedules */

  app.post('/api/coverage/schedules', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.persona_id !== 'string' || !b.persona_id) {
      reply.code(400).send({ error: 'ValidationError', details: ['persona_id is required'] });
      return;
    }
    if (!Array.isArray(b.weekly_windows) || b.weekly_windows.length === 0) {
      throw new CoverageValidationError('weekly_windows must be a non-empty array');
    }
    const schedule = await upsertSchedule({
      tenant_id,
      persona_id: b.persona_id,
      iana_timezone: String(b.iana_timezone ?? ''),
      // Typed, not cast. `as never` here is what let the array the route demands
      // drift from the ISO-weekday map the evaluator reads; upsertSchedule now
      // accepts both and normalises, and the type says so.
      weekly_windows: b.weekly_windows as WeekdayWindow[],
      holiday_region: typeof b.holiday_region === 'string' ? b.holiday_region : undefined,
    });
    reply.code(201).send({ data: { schedule } });
  }));

  app.get('/api/coverage/schedules', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const schedules = await listSchedules({
      tenant_id,
      persona_id: typeof q.persona_id === 'string' ? q.persona_id : undefined,
    });
    reply.code(200).send({ data: { schedules } });
  }));

  /* --------------------------------------------------------- time off */

  app.post('/api/coverage/time-off', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.persona_id !== 'string' || !b.persona_id) {
      reply.code(400).send({ error: 'ValidationError', details: ['persona_id is required'] });
      return;
    }
    const time_off = await recordTimeOff({
      tenant_id,
      persona_id: b.persona_id,
      kind: b.kind as TimeOffKind,
      starts_at: parseDate(b.starts_at, 'starts_at'),
      ends_at: parseDate(b.ends_at, 'ends_at'),
      reason: typeof b.reason === 'string' ? b.reason : undefined,
      source: typeof b.source === 'string' ? (b.source as PresenceSource) : undefined,
      source_ref: typeof b.source_ref === 'string' ? b.source_ref : undefined,
    });
    reply.code(201).send({ data: { time_off } });
  }));

  app.get('/api/coverage/time-off', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const time_off = await listTimeOff({
      tenant_id,
      persona_id: typeof q.persona_id === 'string' ? q.persona_id : undefined,
    });
    reply.code(200).send({ data: { time_off } });
  }));

  /* ------------------------------------------------- holiday calendars */

  app.post('/api/coverage/holiday-calendars', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const calendar = await upsertHolidayCalendar({
      tenant_id,
      region: String(b.region ?? ''),
      dates: Array.isArray(b.dates) ? (b.dates as string[]) : [],
      name: typeof b.name === 'string' ? b.name : undefined,
      maintained_by: typeof b.maintained_by === 'string' ? b.maintained_by : undefined,
    });
    reply.code(201).send({ data: { calendar } });
  }));

  app.get('/api/coverage/holiday-calendars', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    reply.code(200).send({ data: { calendars: await listHolidayCalendars(tenant_id) } });
  }));

  /* --------------------------------------------------------- presence */

  app.put('/api/coverage/presence', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.persona_id !== 'string' || !b.persona_id) {
      reply.code(400).send({ error: 'ValidationError', details: ['persona_id is required'] });
      return;
    }
    const result = await setPresence({
      tenant_id,
      persona_id: b.persona_id,
      status: b.status as PresenceStatus,
      source: typeof b.source === 'string' ? (b.source as PresenceSource) : undefined,
      source_ref: typeof b.source_ref === 'string' ? b.source_ref : undefined,
      manual_hold_minutes:
        typeof b.manual_hold_minutes === 'number' ? b.manual_hold_minutes : undefined,
    });
    // 200 with applied=false, not a 4xx: an outranked calendar sync is correct
    // behaviour, and erroring would have integrations logging failures for it.
    reply.code(200).send({ data: result });
  }));

  /* --------------------------------------------------------- eligible */

  app.get('/api/coverage/eligible', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const result = await findEligible({
      tenant_id,
      at: typeof q.at === 'string' ? parseDate(q.at, 'at') : undefined,
      persona_ids:
        typeof q.persona_ids === 'string' && q.persona_ids
          ? q.persona_ids.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
      role_ref: typeof q.role_ref === 'string' ? q.role_ref : undefined,
      band: typeof q.band === 'string' ? q.band : undefined,
      include_ineligible: q.include_ineligible !== 'false',
      ignore_presence: q.ignore_presence === 'true',
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    });
    reply.code(200).send({ data: result });
  }));

  /* ------------------------------------------------------------- gaps */

  app.get('/api/coverage/gaps', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.rotation_ref !== 'string' || !q.rotation_ref) {
      reply.code(400).send({ error: 'ValidationError', details: ['rotation_ref is required'] });
      return;
    }
    const now = new Date();
    const gaps = await detectGaps({
      tenant_id,
      rotation_ref: q.rotation_ref,
      from: typeof q.from === 'string' ? parseDate(q.from, 'from') : now,
      to:
        typeof q.to === 'string'
          ? parseDate(q.to, 'to')
          : new Date(now.getTime() + 7 * 24 * 3600_000),
      tier: typeof q.tier === 'string' ? Number(q.tier) : undefined,
      lead_minutes: typeof q.lead_minutes === 'string' ? Number(q.lead_minutes) : undefined,
    });
    reply.code(200).send({
      data: {
        rotation_ref: q.rotation_ref,
        gaps,
        imminent: gaps.filter((g) => g.imminent).length,
      },
    });
  }));

  /* ---------------------------------------------------------- on call */

  app.post('/api/coverage/on-call', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.rotation_ref !== 'string' || !b.rotation_ref.trim()) {
      reply.code(400).send({ error: 'ValidationError', details: ['rotation_ref is required'] });
      return;
    }
    if (typeof b.persona_id !== 'string' || !b.persona_id) {
      reply.code(400).send({ error: 'ValidationError', details: ['persona_id is required'] });
      return;
    }
    const tier = b.tier === undefined ? 1 : Number(b.tier);
    if (!Number.isInteger(tier) || tier < 1) {
      throw new CoverageValidationError('tier must be an integer of 1 or more');
    }
    const starts_at = parseDate(b.starts_at, 'starts_at');
    const ends_at = parseDate(b.ends_at, 'ends_at');
    if (!(ends_at > starts_at)) {
      throw new CoverageValidationError('ends_at must be after starts_at');
    }

    const entry = await addRosterEntry({
      tenant_id,
      rotation_ref: b.rotation_ref,
      persona_id: b.persona_id,
      tier,
      starts_at,
      ends_at,
      role_ref: typeof b.role_ref === 'string' ? b.role_ref : undefined,
      is_manager_on_duty: b.is_manager_on_duty === true,
    });
    reply.code(201).send({ data: { entry } });
  }));

  app.get('/api/coverage/on-call', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const roster = await listRoster({
      tenant_id,
      rotation_ref: typeof q.rotation_ref === 'string' ? q.rotation_ref : undefined,
    });
    reply.code(200).send({ data: { roster } });
  }));

  app.get('/api/coverage/on-call/current', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const resolution = await resolveOnCall({
      tenant_id,
      rotation_ref: typeof q.rotation_ref === 'string' ? q.rotation_ref : undefined,
      at: typeof q.at === 'string' ? parseDate(q.at, 'at') : undefined,
      max_tier: typeof q.max_tier === 'string' ? Number(q.max_tier) : undefined,
      role_ref: typeof q.role_ref === 'string' ? q.role_ref : undefined,
    });
    reply.code(200).send({ data: resolution });
  }));

  /* ------------------------------------------------- capacity policies */

  app.post('/api/coverage/capacity-policies', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const policy = await upsertCapacityPolicy({
      tenant_id,
      persona_id: typeof b.persona_id === 'string' ? b.persona_id : undefined,
      role_ref: typeof b.role_ref === 'string' ? b.role_ref : undefined,
      max_concurrent_by_band: (b.max_concurrent_by_band ?? {}) as Record<string, number>,
      freeze_threshold: typeof b.freeze_threshold === 'number' ? b.freeze_threshold : undefined,
      freeze_threshold_by_band: (b.freeze_threshold_by_band ?? {}) as Record<string, number>,
      daily_cap: typeof b.daily_cap === 'number' ? b.daily_cap : null,
    });
    reply.code(201).send({ data: { policy } });
  }));

  app.get('/api/coverage/capacity-policies', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    reply.code(200).send({ data: { policies: await listCapacityPolicies(tenant_id) } });
  }));

  /* ----------------------------------------------- backup designations */

  app.post('/api/coverage/backup-designations', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.primary_persona_id !== 'string' || typeof b.backup_persona_id !== 'string') {
      reply.code(400).send({
        error: 'ValidationError',
        details: ['primary_persona_id and backup_persona_id are required'],
      });
      return;
    }
    const designation = await designateBackup({
      tenant_id,
      primary_persona_id: b.primary_persona_id,
      backup_persona_id: b.backup_persona_id,
      scope: typeof b.scope === 'string' ? b.scope : undefined,
      acceptance_window_minutes:
        typeof b.acceptance_window_minutes === 'number' ? b.acceptance_window_minutes : undefined,
    });
    reply.code(201).send({ data: { designation } });
  }));

  app.get('/api/coverage/backup-designations', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    reply.code(200).send({ data: { designations: await listBackups(tenant_id) } });
  }));
}
