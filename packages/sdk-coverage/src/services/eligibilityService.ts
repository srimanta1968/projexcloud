import { dataService } from '@projexlight/db-runtime';
import {
  isWithinWindowsAt,
  localParts,
  UnknownTimezone,
  assertNamedTimezone,
  type LocalParts,
  type WorkingWindow,
} from './timezone';
// Value import, and safe: presenceService only imports TYPES back from here, which
// are erased, so there is no runtime cycle.
import { CoverageValidationError } from './presenceService';

/**
 * sdk-coverage eligibility engine (P16 · EP-377 · PCF-04-2).
 *
 * THE core primitive of this package, and the one every other consumer is really
 * asking for: who can act right now?
 *
 *   schedule MINUS time-off MINUS holiday, intersected with live presence and
 *   capacity headroom.
 *
 * Three properties define it.
 *
 *   1. IT NEVER RETURNS SOMEBODY WHO CANNOT ACT. Every exclusion is a separate
 *      check and each one is sufficient on its own; a persona is eligible only by
 *      surviving all of them. That direction matters — a design that starts from
 *      "eligible unless proven otherwise" fails open, and failing open here means
 *      routing real work to somebody on annual leave.
 *
 *   2. IT SAYS WHY, AND SAYS EVERY WHY. Reasons are collected rather than
 *      short-circuited, so a routing decision can explain that a persona was
 *      skipped for being off shift AND at capacity. Answering "not eligible" with
 *      one reason invites somebody to fix that reason and be surprised again.
 *
 *   3. IT ANSWERS IN ONE ROUND OF QUERIES. Five bulk reads, then pure in-memory
 *      evaluation — no per-persona query anywhere. That is what keeps a
 *      500-persona tenant inside the 50ms budget, and it is a structural property
 *      rather than a tuning exercise.
 *
 * Everything is evaluated in the PERSONA'S OWN timezone, because "are they
 * working" is a question about their morning, not the server's.
 */

const SCHEDULE_COLS = `
  schedule_id, tenant_id, persona_id, weekly_windows, iana_timezone, holiday_region,
  effective_from, effective_to, is_active, metadata, created_at, updated_at`;

export type PresenceStatus = 'AVAILABLE' | 'MEETING' | 'OFFLINE' | 'PTO' | 'ON_CALL';
export type PresenceSource = 'MANUAL' | 'CALENDAR' | 'SYSTEM';
export type TimeOffKind = 'PTO' | 'MEETING' | 'OUTAGE' | 'HOLIDAY';

/** Presence values from which a persona can take new work. */
const PRESENCE_CAN_ACT: PresenceStatus[] = ['AVAILABLE', 'ON_CALL'];

export interface WorkSchedule {
  schedule_id: string;
  tenant_id: string;
  persona_id: string;
  weekly_windows: Record<string, WorkingWindow[]>;
  iana_timezone: string;
  holiday_region: string | null;
  effective_from: string | null;
  effective_to: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One persona's whole picture, assembled by the single joined query. */
interface EligibilityRow extends WorkSchedule {
  time_off_items: Array<{ kind: TimeOffKind; reason: string | null }>;
  presence_status: PresenceStatus | null;
  presence_source: PresenceSource | null;
  is_holiday: boolean;
  persona_policy_id: string | null;
  persona_bands: Record<string, number> | null;
  persona_daily_cap: number | null;
  persona_freeze: string | number | null;
  persona_freeze_by_band: Record<string, number> | null;
  role_policy_id: string | null;
  role_bands: Record<string, number> | null;
  role_daily_cap: number | null;
  role_freeze: string | number | null;
  role_freeze_by_band: Record<string, number> | null;
}

export interface CapacityPolicyRow {
  capacity_policy_id: string;
  tenant_id: string;
  persona_id: string | null;
  role_ref: string | null;
  max_concurrent_by_band: Record<string, number>;
  daily_cap: number | null;
  freeze_threshold: string | number;
  freeze_threshold_by_band: Record<string, number>;
  is_active: boolean;
}

/** Why a persona cannot act. Machine-readable prefix, human-readable detail. */
export interface EligibilityReason {
  code:
    | 'NO_SCHEDULE'
    | 'SCHEDULE_NOT_EFFECTIVE'
    | 'OUTSIDE_SCHEDULE'
    | 'TIME_OFF'
    | 'HOLIDAY'
    | 'PRESENCE'
    | 'AT_CAPACITY'
    | 'DAILY_CAP_REACHED'
    | 'CAPACITY_UNKNOWN'
    | 'UNKNOWN_TIMEZONE';
  detail: string;
}

export interface EligiblePersona {
  persona_id: string;
  timezone: string;
  presence_status: PresenceStatus;
  presence_source: PresenceSource;
  on_call: boolean;
  /** Live count per band, from the wired load provider. Empty when uncapped and unmeasured. */
  current_load: Record<string, number>;
  total_load: number;
  /** null for a band with no limit — uncapped is not the same as a large number. */
  remaining_headroom: Record<string, number | null>;
  /** The tightest band, which is what a router should sort on. null when uncapped. */
  min_remaining_headroom: number | null;
  daily_remaining: number | null;
}

export interface IneligiblePersona {
  persona_id: string;
  reasons: EligibilityReason[];
}

export interface EligibilityResult {
  at: string;
  eligible: EligiblePersona[];
  ineligible: IneligiblePersona[];
  evaluated: number;
  took_ms: number;
  /** False when a capacity policy existed but no load provider was wired. */
  capacity_evaluated: boolean;
}

/* ------------------------------------------------------- load provider */

export type LoadProvider = (input: {
  tenant_id: string;
  persona_ids: string[];
  at: string;
}) => Promise<Record<string, Record<string, number>>>;

let loadProvider: LoadProvider | null = null;

/**
 * Wire live load measurement — sdk-assignment's open-work counts per band.
 *
 * There is NO default. A default returning zero would report full headroom for
 * everybody, so a tenant that set capacity limits would have them silently
 * ignored, and the failure would surface as an overloaded person rather than as an
 * error. Instead, a persona with a capacity policy and no way to measure load is
 * excluded with CAPACITY_UNKNOWN: unknown is treated as unavailable, the same way
 * every other fail-closed gate in the platform treats it. A persona with NO policy
 * is uncapped and stays eligible, because absent policy genuinely means no limit.
 */
export function setLoadProvider(fn: LoadProvider | null): void {
  loadProvider = fn;
}

export function hasLoadProvider(): boolean {
  return loadProvider !== null;
}

/* ------------------------------------------------------------ the query */

export interface FindEligibleInput {
  tenant_id: string;
  /** Defaults to now. */
  at?: Date;
  /** Restrict to these personas; otherwise every persona with a schedule. */
  persona_ids?: string[];
  /** Match role-scoped capacity policies and roster entries. */
  role_ref?: string;
  /** Which band the work belongs to. Headroom is reported for all bands regardless. */
  band?: string;
  /** Include the ineligible with their reasons. On by default: the reasons are the point. */
  include_ineligible?: boolean;
  /** Treat presence as advisory — for planning questions rather than routing ones. */
  ignore_presence?: boolean;
  limit?: number;
}

export async function findEligible(input: FindEligibleInput): Promise<EligibilityResult> {
  const startedAt = Date.now();
  const at = input.at ?? new Date();
  const atMs = at.getTime();
  const atIso = at.toISOString();
  const limit = Math.min(Math.max(input.limit ?? 1000, 1), 5000);

  /*
   * ONE query. No per-persona read anywhere below this point.
   *
   * It was five, and five was wrong: each round trip carries a fixed cost that has
   * nothing to do with how much data comes back — measured at ~2.5ms apiece on a
   * warm local pool — so five of them spent more of the 50ms budget than the entire
   * evaluation did. Joining them is not a micro-optimisation; it makes the budget a
   * structural property of the query plan rather than something that holds only
   * while the database happens to be close by.
   *
   * Two things are computed in SQL rather than shipped to JS:
   *   - the persona's LOCAL date, via AT TIME ZONE on their own zone, so the
   *     holiday test is an array membership check on one boolean instead of
   *     transferring every region's date list alongside all 500 rows;
   *   - the covering time-off intervals, aggregated to one jsonb array per persona
   *     so a persona on PTO and in a meeting stays one row rather than multiplying
   *     the result set.
   */
  const rows = await dataService.rows<EligibilityRow>(
    `WITH s AS (
       SELECT ${SCHEDULE_COLS}
         FROM coverage.work_schedule
        WHERE tenant_id = $1 AND is_active
          AND ($2::uuid[] IS NULL OR persona_id = ANY($2::uuid[]))
        ORDER BY persona_id
        LIMIT ${limit}
     )
     SELECT s.*,
            COALESCE(t.items, '[]'::jsonb) AS time_off_items,
            p.status AS presence_status,
            p.source AS presence_source,
            COALESCE(h.is_holiday, false) AS is_holiday,
            cp.capacity_policy_id AS persona_policy_id,
            cp.max_concurrent_by_band AS persona_bands,
            cp.daily_cap AS persona_daily_cap,
            cp.freeze_threshold AS persona_freeze,
            cp.freeze_threshold_by_band AS persona_freeze_by_band,
            rp.capacity_policy_id AS role_policy_id,
            rp.max_concurrent_by_band AS role_bands,
            rp.daily_cap AS role_daily_cap,
            rp.freeze_threshold AS role_freeze,
            rp.freeze_threshold_by_band AS role_freeze_by_band
       FROM s
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('kind', o.kind, 'reason', o.reason)) AS items
           FROM coverage.time_off o
          WHERE o.tenant_id = s.tenant_id AND o.persona_id = s.persona_id
            AND o.starts_at <= $3::timestamptz AND o.ends_at > $3::timestamptz
       ) t ON true
       LEFT JOIN coverage.presence p
              ON p.tenant_id = s.tenant_id AND p.persona_id = s.persona_id
       LEFT JOIN LATERAL (
         SELECT (hc.dates @> ARRAY[(($3::timestamptz) AT TIME ZONE s.iana_timezone)::date]) AS is_holiday
           FROM coverage.holiday_calendar hc
          WHERE hc.tenant_id = s.tenant_id AND hc.is_active
            AND s.holiday_region IS NOT NULL AND hc.region = s.holiday_region
          LIMIT 1
       ) h ON true
       LEFT JOIN coverage.capacity_policy cp
              ON cp.tenant_id = s.tenant_id AND cp.persona_id = s.persona_id AND cp.is_active
       LEFT JOIN LATERAL (
         SELECT rcp.* FROM coverage.capacity_policy rcp
          WHERE rcp.tenant_id = s.tenant_id AND rcp.is_active
            AND $4::text IS NOT NULL AND rcp.role_ref = $4
          LIMIT 1
       ) rp ON true`,
    [input.tenant_id, input.persona_ids ?? null, atIso, input.role_ref ?? null],
  );

  if (rows.length === 0) {
    return {
      at: atIso, eligible: [], ineligible: [], evaluated: 0,
      took_ms: Date.now() - startedAt, capacity_evaluated: true,
    };
  }
  const schedules = rows;
  const personaIds = rows.map((s) => s.persona_id);

  const policyOf = (row: EligibilityRow): CapacityPolicyRow | null => {
    if (row.persona_policy_id) {
      return {
        capacity_policy_id: row.persona_policy_id,
        tenant_id: input.tenant_id,
        persona_id: row.persona_id,
        role_ref: null,
        max_concurrent_by_band: row.persona_bands ?? {},
        daily_cap: row.persona_daily_cap,
        freeze_threshold: row.persona_freeze ?? 1,
        freeze_threshold_by_band: row.persona_freeze_by_band ?? {},
        is_active: true,
      };
    }
    if (row.role_policy_id) {
      return {
        capacity_policy_id: row.role_policy_id,
        tenant_id: input.tenant_id,
        persona_id: null,
        role_ref: input.role_ref ?? null,
        max_concurrent_by_band: row.role_bands ?? {},
        daily_cap: row.role_daily_cap,
        freeze_threshold: row.role_freeze ?? 1,
        freeze_threshold_by_band: row.role_freeze_by_band ?? {},
        is_active: true,
      };
    }
    return null;
  };

  /* ---- load, once, for everybody ---- */

  const needsCapacity = schedules.some((s) => policyOf(s) !== null);
  let loads: Record<string, Record<string, number>> = {};
  let capacityEvaluated = true;
  if (needsCapacity) {
    if (loadProvider) {
      loads = (await loadProvider({ tenant_id: input.tenant_id, persona_ids: personaIds, at: atIso })) ?? {};
    } else {
      capacityEvaluated = false;
    }
  }

  /* ---- pure evaluation ---- */

  const eligible: EligiblePersona[] = [];
  const ineligible: IneligiblePersona[] = [];
  const includeIneligible = input.include_ineligible ?? true;

  /*
   * One instant, many personas — so resolve it ONCE per distinct timezone rather
   * than once per persona. formatToParts dominates the cost of this loop, and a
   * tenant has a handful of zones however many people it employs; recomputing per
   * persona is what put a 500-persona sweep at 80ms instead of single digits.
   * Failures are cached too, so a bad zone costs one attempt rather than one per
   * persona sharing it.
   */
  const localByZone = new Map<string, LocalParts | Error>();
  const resolveLocal = (timezone: string): LocalParts | Error => {
    const cached = localByZone.get(timezone);
    if (cached) return cached;
    let resolved: LocalParts | Error;
    try {
      resolved = localParts(atMs, timezone);
    } catch (err) {
      resolved = err instanceof Error ? err : new Error(String(err));
    }
    localByZone.set(timezone, resolved);
    return resolved;
  };

  for (const schedule of schedules) {
    const reasons: EligibilityReason[] = [];
    const personaId = schedule.persona_id;

    // -- schedule
    const resolved = resolveLocal(schedule.iana_timezone);
    const local: LocalParts | null = resolved instanceof Error ? null : resolved;
    if (resolved instanceof Error) {
      reasons.push({
        code: 'UNKNOWN_TIMEZONE',
        detail: resolved instanceof UnknownTimezone
          ? resolved.message
          : `timezone '${schedule.iana_timezone}' could not be resolved`,
      });
    }

    if (local) {
      if (schedule.effective_from && local.date < String(schedule.effective_from).slice(0, 10)) {
        reasons.push({
          code: 'SCHEDULE_NOT_EFFECTIVE',
          detail: `schedule starts on ${String(schedule.effective_from).slice(0, 10)}`,
        });
      }
      if (schedule.effective_to && local.date > String(schedule.effective_to).slice(0, 10)) {
        reasons.push({
          code: 'SCHEDULE_NOT_EFFECTIVE',
          detail: `schedule ended on ${String(schedule.effective_to).slice(0, 10)}`,
        });
      }
      const windows = schedule.weekly_windows ?? {};
      if (Object.keys(windows).length === 0) {
        reasons.push({ code: 'NO_SCHEDULE', detail: 'no working windows are configured' });
      } else if (!isWithinWindowsAt(windows, local)) {
        reasons.push({
          code: 'OUTSIDE_SCHEDULE',
          detail: `${local.date} ${String(Math.floor(local.minuteOfDay / 60)).padStart(2, '0')}:${String(local.minuteOfDay % 60).padStart(2, '0')} is outside their working windows (${schedule.iana_timezone})`,
        });
      }

      // -- holiday. The date comparison already happened in SQL, in the persona's
      //    own zone, so this is just the answer.
      if (schedule.is_holiday && schedule.holiday_region) {
        reasons.push({
          code: 'HOLIDAY',
          detail: `${local.date} is a holiday in ${schedule.holiday_region}`,
        });
      }
    }

    // -- time off. Every covering interval is reported, not just the first: "on
    //    PTO and in a meeting" is two different things to know.
    for (const t of schedule.time_off_items ?? []) {
      reasons.push({
        code: 'TIME_OFF',
        detail: t.reason ? `${t.kind}: ${t.reason}` : String(t.kind),
      });
    }

    // -- presence. A persona nobody has ever reported on is OFFLINE, not assumed
    //    available: silence is not a claim that somebody is at their desk.
    const status: PresenceStatus = schedule.presence_status ?? 'OFFLINE';
    const source: PresenceSource = schedule.presence_source ?? 'SYSTEM';
    if (!input.ignore_presence && !PRESENCE_CAN_ACT.includes(status)) {
      reasons.push({
        code: 'PRESENCE',
        detail: schedule.presence_status
          ? `presence is ${status} (set by ${source})`
          : 'no presence has ever been reported for this persona',
      });
    }

    // -- capacity
    const policy = policyOf(schedule);
    const load = loads[personaId] ?? {};
    const remaining: Record<string, number | null> = {};
    let minRemaining: number | null = null;
    let dailyRemaining: number | null = null;

    if (policy) {
      if (!capacityEvaluated) {
        reasons.push({
          code: 'CAPACITY_UNKNOWN',
          detail: 'a capacity policy applies but no load provider is wired, so headroom cannot be measured — treating unknown as unavailable',
        });
      } else {
        const bands = policy.max_concurrent_by_band ?? {};
        const perBandFreeze = policy.freeze_threshold_by_band ?? {};
        const defaultFreeze = Number(policy.freeze_threshold ?? 1);
        for (const [band, rawLimit] of Object.entries(bands)) {
          const limit = Number(rawLimit);
          if (!Number.isFinite(limit)) continue;
          const used = Number(load[band] ?? 0);
          const freeze = Number(perBandFreeze[band] ?? defaultFreeze);
          // The freeze threshold reserves headroom BEFORE the hard limit, so work
          // stops arriving while somebody still has room to finish what they hold.
          const effective = Math.floor(limit * freeze);
          const left = effective - used;
          remaining[band] = left;
          if (minRemaining === null || left < minRemaining) minRemaining = left;
          if (left <= 0 && (input.band === undefined || input.band === band)) {
            reasons.push({
              code: 'AT_CAPACITY',
              detail: `band '${band}' is at ${used}/${limit}${freeze < 1 ? ` (frozen at ${Math.round(freeze * 100)}%)` : ''}`,
            });
          }
        }
        const total = Object.values(load).reduce((a, b) => a + Number(b || 0), 0);
        if (policy.daily_cap !== null && policy.daily_cap !== undefined) {
          dailyRemaining = Number(policy.daily_cap) - total;
          if (dailyRemaining <= 0) {
            reasons.push({
              code: 'DAILY_CAP_REACHED',
              detail: `daily cap of ${policy.daily_cap} reached (${total} held)`,
            });
          }
        }
      }
    }
    // A band the policy does not mention is uncapped, which is different from a
    // band capped at zero — say so with null rather than a number.
    if (input.band && !(input.band in remaining)) remaining[input.band] = null;

    if (reasons.length > 0) {
      if (includeIneligible) ineligible.push({ persona_id: personaId, reasons });
      continue;
    }

    const totalLoad = Object.values(load).reduce((a, b) => a + Number(b || 0), 0);
    eligible.push({
      persona_id: personaId,
      timezone: schedule.iana_timezone,
      presence_status: status,
      presence_source: source,
      on_call: status === 'ON_CALL',
      current_load: load,
      total_load: totalLoad,
      remaining_headroom: remaining,
      min_remaining_headroom: minRemaining,
      daily_remaining: dailyRemaining,
    });
  }

  // Most headroom first: a router that picks the least-loaded eligible persona
  // gets the right answer by taking the head of this list. Uncapped sorts first
  // because it genuinely has the most room.
  eligible.sort((a, b) => {
    const ax = a.min_remaining_headroom ?? Number.POSITIVE_INFINITY;
    const bx = b.min_remaining_headroom ?? Number.POSITIVE_INFINITY;
    if (ax !== bx) return bx - ax;
    return a.total_load - b.total_load;
  });

  return {
    at: atIso,
    eligible,
    ineligible,
    evaluated: schedules.length,
    took_ms: Date.now() - startedAt,
    capacity_evaluated: capacityEvaluated,
  };
}

/** One persona, same rules. Returns the reasons when they cannot act. */
export async function isEligible(input: {
  tenant_id: string;
  persona_id: string;
  at?: Date;
  role_ref?: string;
  band?: string;
}): Promise<{ eligible: boolean; persona: EligiblePersona | null; reasons: EligibilityReason[] }> {
  const result = await findEligible({
    tenant_id: input.tenant_id,
    at: input.at,
    persona_ids: [input.persona_id],
    role_ref: input.role_ref,
    band: input.band,
    include_ineligible: true,
  });
  const hit = result.eligible.find((e) => e.persona_id === input.persona_id) ?? null;
  const miss = result.ineligible.find((e) => e.persona_id === input.persona_id);
  return {
    eligible: hit !== null,
    persona: hit,
    reasons: miss?.reasons
      ?? (hit ? [] : [{ code: 'NO_SCHEDULE', detail: 'no active schedule exists for this persona' }]),
  };
}

/* ------------------------------------- the sdk-assignment availability seam */

/**
 * The shape sdk-assignment's step 4 asks for. Declared structurally rather than
 * imported: sdk-coverage must not depend on what is being scheduled (the same rule
 * that keeps setLoadProvider and makeSlaOnCallResolver hooks instead of imports),
 * and the neutrality test enforces it.
 */
export interface AssignmentAvailabilityQuery {
  tenant_id: string;
  persona_ids: string[];
  at: Date;
  band?: string;
  ignore_presence?: boolean;
}

export interface AssignmentAvailabilityAnswer {
  eligible: Array<{ persona_id: string; min_remaining_headroom: number | null }>;
  ineligible: Array<{ persona_id: string; reasons: Array<{ code: string; detail: string }> }>;
}

/**
 * An AvailabilityResolver for sdk-assignment's routing pipeline.
 *
 * sdk-assignment ships NO default on purpose: unwired, its availability step sends
 * every subject to REVIEW rather than assuming everybody is free. This is the
 * resolver that turns that step on.
 *
 * ONE thing here is not a pass-through. findEligible only knows about personas that
 * HAVE a work_schedule row, so a candidate with no schedule at all comes back in
 * neither list — and a router receiving neither an eligibility nor a reason would
 * report "nobody can act right now" with an empty `excluded`, which is precisely the
 * unexplained skip both packages are built to prevent. Anybody asked about and not
 * accounted for is therefore returned as ineligible with NO_SCHEDULE, the same
 * synthesis isEligible() already does for the single-persona case.
 */
export function makeAssignmentAvailabilityResolver(): (
  q: AssignmentAvailabilityQuery,
) => Promise<AssignmentAvailabilityAnswer> {
  return async ({ tenant_id, persona_ids, at, band, ignore_presence }) => {
    if (persona_ids.length === 0) return { eligible: [], ineligible: [] };

    const result = await findEligible({
      tenant_id,
      at,
      persona_ids,
      band,
      ignore_presence,
      include_ineligible: true,
    });

    const eligible = result.eligible.map((e) => ({
      persona_id: e.persona_id,
      min_remaining_headroom: e.min_remaining_headroom,
    }));
    const ineligible = result.ineligible.map((i) => ({
      persona_id: i.persona_id,
      reasons: i.reasons.map((r) => ({ code: String(r.code), detail: r.detail })),
    }));

    const accounted = new Set([
      ...eligible.map((e) => e.persona_id),
      ...ineligible.map((i) => i.persona_id),
    ]);
    for (const persona_id of persona_ids) {
      if (accounted.has(persona_id)) continue;
      ineligible.push({
        persona_id,
        reasons: [{ code: 'NO_SCHEDULE', detail: 'no active schedule exists for this persona' }],
      });
    }

    return { eligible, ineligible };
  };
}

/* ------------------------------------------------------ schedule writes */

/** A window in the flat array form the HTTP surface accepts. */
export interface WeekdayWindow extends WorkingWindow {
  /** 1 = Monday .. 7 = Sunday. 0 is accepted and read as Sunday. */
  weekday: number;
}

/**
 * Normalise weekly windows to the ISO-weekday map the evaluator reads.
 *
 * THE BUG THIS EXISTS TO CLOSE. POST /api/coverage/schedules requires an ARRAY of
 * {weekday, start, end} and rejects anything else, but isWithinWindowsAt() looks up
 * `weeklyWindows[String(local.weekday)]` — a MAP keyed by ISO weekday. Stored
 * verbatim, an array lookup at key "2" returns the third element: a window OBJECT,
 * not an array of them, so windowsCover's Array.isArray guard rejected it and the
 * persona came back OUTSIDE_SCHEDULE. Every schedule ever written through the API
 * was unmatchable, at every hour of every day, and it read as a routing outcome
 * rather than as a shape error because the pipeline reports OUTSIDE_SCHEDULE for
 * both. The route's `as never` cast is what let the two shapes drift apart.
 *
 * Both forms are accepted here rather than only the map, because the array is the
 * documented request body and the map is the persisted form — the boundary is the
 * one place that can know both.
 *
 * WEEKDAY 0. The evaluator is ISO (1..7, Monday first); the HTTP surface documents
 * 0-6, where 0 is Sunday in every convention that starts at zero. 0 is therefore
 * read as 7 rather than dropped. An out-of-range weekday throws instead of being
 * silently discarded — a window nobody can ever match is exactly the failure this
 * function exists to stop.
 */
export function normaliseWeeklyWindows(
  input: Record<string, WorkingWindow[]> | WeekdayWindow[] | null | undefined,
): Record<string, WorkingWindow[]> {
  if (!input) return {};
  if (!Array.isArray(input)) return input;

  const out: Record<string, WorkingWindow[]> = {};
  for (const w of input) {
    const raw = Number(w?.weekday);
    if (!Number.isInteger(raw) || raw < 0 || raw > 7) {
      throw new CoverageValidationError(
        `weekly_windows: weekday '${String(w?.weekday)}' is out of range — use 1=Monday..7=Sunday (0 is read as Sunday)`,
      );
    }
    const key = String(raw === 0 ? 7 : raw);
    (out[key] ??= []).push({ start: w.start, end: w.end });
  }
  return out;
}

export interface UpsertScheduleInput {
  tenant_id: string;
  persona_id: string;
  /** Either the persisted ISO-weekday map or the flat array the API accepts. */
  weekly_windows: Record<string, WorkingWindow[]> | WeekdayWindow[];
  iana_timezone: string;
  holiday_region?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Replace a persona's active schedule.
 *
 * The previous one is DEACTIVATED rather than deleted, in one transaction with the
 * insert: a schedule is the evidence for why somebody was or was not routed work
 * last month, and deleting it makes that question unanswerable. The partial unique
 * index guarantees only one is ever active.
 */
export async function upsertSchedule(input: UpsertScheduleInput): Promise<WorkSchedule> {
  // Fail before writing rather than at the first eligibility sweep -- and refuse
  // a fixed offset too, which Intl accepts but the database CHECK does not.
  assertNamedTimezone(input.iana_timezone);
  return dataService.tx(async (q) => {
    await q(
      `UPDATE coverage.work_schedule SET is_active = false
        WHERE tenant_id = $1 AND persona_id = $2 AND is_active`,
      [input.tenant_id, input.persona_id],
    );
    const inserted = await q<WorkSchedule>(
      `INSERT INTO coverage.work_schedule
         (tenant_id, persona_id, weekly_windows, iana_timezone, holiday_region,
          effective_from, effective_to, metadata)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::date, $7::date, $8::jsonb)
       RETURNING ${SCHEDULE_COLS}`,
      [
        input.tenant_id, input.persona_id,
        JSON.stringify(normaliseWeeklyWindows(input.weekly_windows)),
        input.iana_timezone, input.holiday_region ?? null,
        input.effective_from ?? null, input.effective_to ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return inserted.rows[0];
  });
}

export async function getSchedule(
  tenant_id: string,
  persona_id: string,
): Promise<WorkSchedule | null> {
  return dataService.one<WorkSchedule>(
    `SELECT ${SCHEDULE_COLS} FROM coverage.work_schedule
      WHERE tenant_id = $1 AND persona_id = $2 AND is_active`,
    [tenant_id, persona_id],
  );
}

export async function listSchedules(filter: {
  tenant_id: string;
  /** Narrow to one persona. The list endpoint documents this, so it lives here. */
  persona_id?: string;
  limit?: number;
  offset?: number;
}): Promise<WorkSchedule[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<WorkSchedule>(
    `SELECT ${SCHEDULE_COLS} FROM coverage.work_schedule
      WHERE tenant_id = $1 AND is_active
        AND ($2::uuid IS NULL OR persona_id = $2)
      ORDER BY persona_id
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.persona_id ?? null],
  );
}
