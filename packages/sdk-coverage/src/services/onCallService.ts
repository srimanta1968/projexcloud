import { dataService } from '@projexlight/db-runtime';

/**
 * Who answers right now, and where the rota has holes.
 *
 * Two questions, deliberately kept apart:
 *
 *   resolveOnCall  — WHO is on call at an instant, by tier. Consumed by
 *                    sdk-sla's escalation ladder, which refuses to fire a rung
 *                    at an empty audience rather than escalate to nobody.
 *   findRosterGaps — WHERE nobody is on call over a window. This is the one that
 *                    has to run BEFORE the window opens: a gap discovered while
 *                    an incident is escalating is not a warning, it is an outage.
 *
 * Roster entries overlap on purpose — tier 1 and tier 2 are both on call at once,
 * which is what a tier means. So there is no exclusion constraint and no
 * "current on-call" column; the intervals stay intervals and the answer is
 * computed at the instant it is asked about.
 */

export interface OnCallEntry {
  roster_id: string;
  tenant_id: string;
  rotation_ref: string;
  role_ref: string | null;
  persona_id: string;
  tier: number;
  starts_at: Date;
  ends_at: Date;
  is_manager_on_duty: boolean;
}

export interface OnCallResolution {
  rotation_ref: string;
  at: string;
  /** Tiers present at this instant, ascending — tier 1 answers first. */
  tiers: Array<{ tier: number; persona_ids: string[] }>;
  /** Every persona on call, tier order preserved and de-duplicated. */
  persona_ids: string[];
  /** Whoever is flagged manager-on-duty at this instant, if anybody is. */
  manager_on_duty_ids: string[];
  /** True when nobody at all is on call — the caller must not treat this as an empty success. */
  uncovered: boolean;
}

const ENTRY_COLUMNS = `roster_id, tenant_id, rotation_ref, role_ref, persona_id,
       tier, starts_at, ends_at, is_manager_on_duty`;

export interface ResolveOnCallInput {
  tenant_id: string;
  rotation_ref?: string;
  /** Defaults to now. Resolve for THIS instant, not for when the policy was written. */
  at?: Date;
  /** Ignore tiers above this one. Absent means every tier. */
  max_tier?: number;
  role_ref?: string;
}

/**
 * Resolves the on-call audience at an instant.
 *
 * The interval test is half-open — `starts_at <= at < ends_at`. A closed test
 * would put two shifts on call during the changeover second and page both; an
 * open one would leave that second uncovered. Half-open is the only choice that
 * hands over cleanly, and it has to match the gap detector below or a handover
 * will look like a gap.
 */
export async function resolveOnCall(input: ResolveOnCallInput): Promise<OnCallResolution> {
  const at = input.at ?? new Date();
  const rows = await dataService.rows<OnCallEntry>(
    `SELECT ${ENTRY_COLUMNS}
       FROM coverage.on_call_roster
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR rotation_ref = $2)
        AND ($3::text IS NULL OR role_ref = $3 OR role_ref IS NULL)
        AND starts_at <= $4 AND ends_at > $4
        AND ($5::int IS NULL OR tier <= $5)
      ORDER BY tier ASC, starts_at ASC`,
    [input.tenant_id, input.rotation_ref ?? null, input.role_ref ?? null, at, input.max_tier ?? null],
  );

  const byTier = new Map<number, string[]>();
  const seen = new Set<string>();
  const ordered: string[] = [];
  const managers: string[] = [];

  for (const row of rows) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    const bucket = byTier.get(row.tier) as string[];
    if (!bucket.includes(row.persona_id)) bucket.push(row.persona_id);
    if (!seen.has(row.persona_id)) {
      seen.add(row.persona_id);
      ordered.push(row.persona_id);
    }
    if (row.is_manager_on_duty && !managers.includes(row.persona_id)) {
      managers.push(row.persona_id);
    }
  }

  return {
    rotation_ref: input.rotation_ref ?? '*',
    at: at.toISOString(),
    tiers: [...byTier.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tier, persona_ids]) => ({ tier, persona_ids })),
    persona_ids: ordered,
    manager_on_duty_ids: managers,
    // Stated rather than inferred from an empty array: a caller that treats
    // "nobody on call" as "no result" will silently escalate into the void.
    uncovered: ordered.length === 0,
  };
}

export interface RosterGap {
  starts_at: string;
  ends_at: string;
  minutes: number;
}

export interface FindRosterGapsInput {
  tenant_id: string;
  rotation_ref: string;
  from: Date;
  to: Date;
  /**
   * Which tier must be covered. Defaults to 1: a gap in tier 2 with tier 1 staffed
   * is thin cover, whereas a gap in tier 1 means the first page goes nowhere.
   * Checking every tier at once would merge them and hide exactly that.
   */
  tier?: number;
}

/**
 * Uncovered intervals in [from, to) for one rotation and tier.
 *
 * Merged in JS rather than SQL. The merge is the whole algorithm, and having it
 * as ordinary code means the awkward cases — an interval that starts before the
 * window, two that abut exactly, one that swallows another — are unit-testable
 * without a database.
 */
export async function findRosterGaps(input: FindRosterGapsInput): Promise<RosterGap[]> {
  if (input.to <= input.from) return [];
  const tier = input.tier ?? 1;

  const rows = await dataService.rows<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at
       FROM coverage.on_call_roster
      WHERE tenant_id = $1 AND rotation_ref = $2 AND tier = $3
        AND starts_at < $5 AND ends_at > $4
      ORDER BY starts_at ASC`,
    [input.tenant_id, input.rotation_ref, tier, input.from, input.to],
  );

  return gapsBetween(
    rows.map((r) => ({ start: new Date(r.starts_at).getTime(), end: new Date(r.ends_at).getTime() })),
    input.from.getTime(),
    input.to.getTime(),
  );
}

/**
 * Pure interval arithmetic, exported so it can be tested exhaustively without a
 * database — which is where the off-by-one lives.
 *
 * Abutting intervals (one ends exactly when the next begins) produce NO gap. That
 * is the normal shape of a clean handover, and reporting a zero-length gap for
 * every shift change would bury the real ones.
 */
export function gapsBetween(
  intervals: Array<{ start: number; end: number }>,
  from: number,
  to: number,
): RosterGap[] {
  if (to <= from) return [];
  const sorted = [...intervals]
    .filter((i) => i.end > from && i.start < to)
    .sort((a, b) => a.start - b.start);

  const gaps: RosterGap[] = [];
  let cursor = from;

  for (const interval of sorted) {
    // Already covered past this interval's start: it overlaps or is swallowed.
    if (interval.start > cursor) {
      gaps.push(gap(cursor, Math.min(interval.start, to)));
    }
    cursor = Math.max(cursor, interval.end);
    if (cursor >= to) break;
  }

  if (cursor < to) gaps.push(gap(cursor, to));
  return gaps;
}

function gap(startMs: number, endMs: number): RosterGap {
  return {
    starts_at: new Date(startMs).toISOString(),
    ends_at: new Date(endMs).toISOString(),
    minutes: Math.round((endMs - startMs) / 60_000),
  };
}

/* ------------------------------------------------------------- writes */

export interface UpsertRosterEntryInput {
  tenant_id: string;
  rotation_ref: string;
  persona_id: string;
  starts_at: Date;
  ends_at: Date;
  tier?: number;
  role_ref?: string;
  is_manager_on_duty?: boolean;
  metadata?: Record<string, unknown>;
}

export async function addRosterEntry(input: UpsertRosterEntryInput): Promise<OnCallEntry> {
  const rows = await dataService.rows<OnCallEntry>(
    `INSERT INTO coverage.on_call_roster
        (tenant_id, rotation_ref, role_ref, persona_id, tier, starts_at, ends_at,
         is_manager_on_duty, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, rotation_ref, tier, persona_id, starts_at)
       DO UPDATE SET ends_at = EXCLUDED.ends_at,
                     role_ref = EXCLUDED.role_ref,
                     is_manager_on_duty = EXCLUDED.is_manager_on_duty,
                     metadata = EXCLUDED.metadata
     RETURNING ${ENTRY_COLUMNS}`,
    [
      input.tenant_id,
      input.rotation_ref,
      input.role_ref ?? null,
      input.persona_id,
      input.tier ?? 1,
      input.starts_at,
      input.ends_at,
      input.is_manager_on_duty ?? false,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rows[0];
}

export async function listRoster(filter: {
  tenant_id: string;
  rotation_ref?: string;
  from?: Date;
  to?: Date;
}): Promise<OnCallEntry[]> {
  return dataService.rows<OnCallEntry>(
    `SELECT ${ENTRY_COLUMNS}
       FROM coverage.on_call_roster
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR rotation_ref = $2)
        AND ($3::timestamptz IS NULL OR ends_at > $3)
        AND ($4::timestamptz IS NULL OR starts_at < $4)
      ORDER BY rotation_ref ASC, tier ASC, starts_at ASC`,
    [filter.tenant_id, filter.rotation_ref ?? null, filter.from ?? null, filter.to ?? null],
  );
}

export async function removeRosterEntry(tenant_id: string, roster_id: string): Promise<boolean> {
  const res = await dataService.query(
    `DELETE FROM coverage.on_call_roster WHERE tenant_id = $1 AND roster_id = $2`,
    [tenant_id, roster_id],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * An OnCallResolver for sdk-sla's escalation ladder.
 *
 * Returns persona ids in tier order so the ladder pages tier 1 before tier 2.
 * When nobody is on call it returns an EMPTY array and lets the ladder refuse the
 * firing: sdk-sla treats an unresolvable audience as a failure it can retry,
 * which is strictly better than a rung that reports success having notified
 * nobody. Substituting a fallback here would hide the gap the roster is supposed
 * to surface.
 */
export function makeSlaOnCallResolver(): (input: {
  tenant_id: string;
  rotation_ref?: string;
  at: string;
}) => Promise<string[]> {
  return async ({ tenant_id, rotation_ref, at }) => {
    const resolution = await resolveOnCall({
      tenant_id,
      rotation_ref,
      at: new Date(at),
    });
    return resolution.persona_ids;
  };
}
