import { dataService } from '@projexlight/db-runtime';
import { route, type RoutingOutcome } from './routingService';

/**
 * Replaying history against a candidate rule set (P16 · EP-379 · PCF-06-3).
 *
 * The question this answers is "what WOULD have happened", and the only way it is
 * worth anything is if asking it changes nothing. A simulation that assigned anybody,
 * notified anybody or started a single clock would be an experiment performed on
 * production — and the failure mode is the worst kind, because it looks like a report.
 *
 * ZERO SIDE EFFECTS, THREE WAYS:
 *   1. every replay runs with dry_run, so no routing_decision row is written;
 *   2. the effect sinks (assign, notify, clock) are swapped for no-ops that COUNT
 *      their calls for the duration, and restored in a finally;
 *   3. the counts come back in the report, so a future change that starts calling one
 *      of them shows up as a non-zero number rather than as silence.
 *
 * Rotation is NOT reimplemented here. EP-335's assignmentEngine owns the fair-share
 * cursor, and the cursor is deliberately READ rather than advanced — advancing it
 * would be exactly the side effect this file exists to avoid, and would also skew the
 * real rotation for everybody the moment somebody ran a simulation.
 *
 * THE RUN IS RECORDED, and that is not a contradiction. `assignment.simulation_run`
 * gets one immutable row per call so a proposal can cite the evidence it was approved
 * on. The zero-side-effect guarantee is about ROUTING — nothing is assigned, notified,
 * clocked, or written to routing_decision — and side_effects still proves precisely
 * that, by counting routing_decision rows before and after. Recording that a question
 * was asked does not answer it.
 *
 * WHAT THIS DOES NOT PROJECT: SLA OUTCOMES.
 *
 * The report compares WHERE work lands — counts per persona, the outcome mix, and the
 * skew audit. It says nothing about whether a candidate rule set would breach fewer
 * SLAs, and there is deliberately no breaches_before/breaches_after field to fill in.
 * Consumers building a "this reduces breaches" case must NOT infer it from these
 * numbers: a rule set that distributes perfectly evenly can breach more, because a
 * breach is a function of the clock, the calendar and the policy attached to each
 * subject — none of which this replay reads. Doing it honestly means replaying
 * sdk-sla's clock arithmetic per subject against the candidate assignee, which is a
 * separate feature and not something a caller can approximate from per_persona.
 *
 * Until that exists: report distribution, and say distribution.
 */

export interface SimulationSinks {
  assign: (...args: unknown[]) => Promise<void>;
  notify: (...args: unknown[]) => Promise<void>;
  startClock: (...args: unknown[]) => Promise<void>;
}

let sinks: SimulationSinks | null = null;

/** Installed by the caller in production; a simulation replaces them with no-ops. */
export function setSimulationSinks(next: SimulationSinks | null): void {
  sinks = next;
}

export function getSimulationSinks(): SimulationSinks | null {
  return sinks;
}

/* ------------------------------------------------------ the SLA seam */

/** One replayed subject, as the projector needs to see it. */
export interface SlaProjectionQuery {
  tenant_id: string;
  subject_ref: string;
  /** When the decision was originally made — the instant the replay is anchored to. */
  at: Date;
  actual_persona_id: string | null;
  candidate_persona_id: string | null;
  candidate_outcome: RoutingOutcome;
}

/**
 * What a projector may answer per subject.
 *
 * `null` means UNPROJECTABLE and is a first-class answer, not a failure: a subject with
 * no clock, no resolvable policy or no resolvable calendar cannot be reasoned about, and
 * the one thing that must never happen is folding it into "did not breach". A projection
 * that quietly counts unknowns as successes reads as an improvement no matter what the
 * candidate does, which is worse than having no projection at all.
 */
export interface SlaProjectionVerdict {
  actual_breached: boolean;
  candidate_breached: boolean | null;
  /** Machine-readable why, carried through to the report for the null cases. */
  reason: string;
}

export type SlaProjector = (q: SlaProjectionQuery) => Promise<SlaProjectionVerdict | null>;

let slaProjector: SlaProjector | null = null;

/**
 * Wire sdk-sla's clock arithmetic (makeAssignmentSlaProjector).
 *
 * NO DEFAULT, for the same reason the availability resolver has none. Unwired, the
 * report carries no sla_projection at all rather than a zeroed one — an absent section
 * makes a consumer ask, whereas `breaches_after: 0` makes them conclude.
 */
export function setSlaProjector(fn: SlaProjector | null): void {
  slaProjector = fn;
}

export function hasSlaProjector(): boolean {
  return slaProjector !== null;
}

export interface SlaProjection {
  /** Subjects the projector could reason about end to end. */
  projected: number;
  /**
   * Subjects it could NOT, with the reason counts. These are excluded from both
   * breach totals — never silently counted as clean.
   */
  unprojectable: number;
  unprojectable_reasons: Record<string, number>;
  /** Breaches that ACTUALLY happened, over the projected subset only. */
  breaches_before: number;
  /** Breaches the candidate rules would produce, over the same subset. */
  breaches_after: number;
  /** breaches_after - breaches_before. Negative is an improvement. */
  delta: number;
}

export interface PersonaComparison {
  persona_id: string;
  /**
   * COUNTS, not shares. The number of replayed subjects this persona was actually
   * given, under the rules that were in force at the time.
   *
   * Spelled out because the denominator is not obvious and every consumer has to pick
   * one: these do NOT sum to subjects_replayed. A subject that went to REVIEW,
   * UNROUTABLE, or to a FALLBACK with no persona has no owner to attribute, so it is
   * counted in outcome_shift and in NOBODY's per_persona entry. Divide by
   * subjects_replayed and you are computing "share of all subjects"; divide by the sum
   * of actual[] and you are computing "share of subjects that found an owner". Both are
   * legitimate questions and they give different numbers.
   */
  actual: number;
  /** Same count, under the candidate rules. Same denominator caveat as `actual`. */
  candidate: number;
  /** candidate - actual. Positive means the candidate sends this persona MORE work. */
  delta: number;
}

export interface SkewAudit {
  /** Mean assignments per persona under the candidate rules. */
  mean: number;
  /** Personas taking materially MORE than their share. */
  over_allocated: Array<{ persona_id: string; count: number; ratio: number }>;
  /**
   * Personas taking materially LESS — including those taking NOTHING. Starvation is
   * reported separately from over-allocation because they have different causes and
   * different fixes, and a single "imbalance" number hides the person who got zero.
   */
  starved: Array<{ persona_id: string; count: number; ratio: number }>;
  /** Personas eligible for work who received NONE under the candidate. */
  received_nothing: string[];
}

export interface SimulationReport {
  /**
   * The RUN, not the rules. Persisted to assignment.simulation_run and immutable, so a
   * routing proposal can cite this id and a reviewer can re-open the exact numbers
   * months later. candidate_version identifies the RULES — two runs of the same version
   * over different windows or candidate pools are different evidence with the same
   * version number, which is why citing the version alone was never enough.
   */
  simulation_id: string;
  candidate_version: number;
  subjects_replayed: number;
  /** Per persona: what actually happened vs what the candidate would have done. */
  per_persona: PersonaComparison[];
  /** How the mix of outcomes moves — the headline an operator reads first. */
  outcome_shift: Record<RoutingOutcome, { actual: number; candidate: number }>;
  /** Subjects whose destination changes, which is what a reviewer wants to inspect. */
  changed: Array<{
    subject_ref: string;
    actual_persona_id: string | null;
    candidate_persona_id: string | null;
    actual_outcome: RoutingOutcome | null;
    candidate_outcome: RoutingOutcome;
  }>;
  skew: SkewAudit;
  /**
   * Present ONLY when an SLA projector is wired. Absent means "not projected" and must
   * not be read as "no change" — see setSlaProjector.
   */
  sla_projection?: SlaProjection;
  /** Proof, in the report itself, that nothing happened. */
  side_effects: { assignments: number; notifications: number; clocks: number; decisions_written: number };
}

export interface SimulateInput {
  tenant_id: string;
  candidate_version: number;
  rule_set_name?: string;
  /** Replay window over recorded decisions. Defaults to the last 200 decisions. */
  from?: Date;
  to?: Date;
  limit?: number;
  /** Candidates and their specialties, as they would be at decision time. */
  candidate_persona_ids: string[];
  persona_specialties?: Record<string, string[]>;
  /** How far from the mean counts as skewed. 0.5 = 50% above or below. */
  skew_tolerance?: number;
}

interface HistoricalDecision {
  subject_ref: string;
  outcome: RoutingOutcome;
  chosen_persona_id: string | null;
  steps: Array<{ step: string; detail?: Record<string, unknown> }>;
  created_at: Date;
  subject: Record<string, unknown> | null;
}

export async function simulate(input: SimulateInput): Promise<SimulationReport> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2000);
  const history = await dataService.rows<HistoricalDecision>(
    `SELECT d.subject_ref, d.outcome, d.chosen_persona_id, d.steps, d.created_at,
            NULL::jsonb AS subject
       FROM assignment.routing_decision d
      WHERE d.tenant_id = $1
        AND ($2::timestamptz IS NULL OR d.created_at >= $2)
        AND ($3::timestamptz IS NULL OR d.created_at <= $3)
      ORDER BY d.created_at DESC
      LIMIT ${limit}`,
    [input.tenant_id, input.from ?? null, input.to ?? null],
  );

  const counted = { assignments: 0, notifications: 0, clocks: 0 };
  const original = sinks;
  // Swapped, not merely "not called": a code path added later that reaches for a sink
  // hits a counter instead of production, and the count lands in the report.
  sinks = {
    assign: async () => { counted.assignments += 1; },
    notify: async () => { counted.notifications += 1; },
    startClock: async () => { counted.clocks += 1; },
  };

  const decisionsBefore = await countDecisions(input.tenant_id);
  const per = new Map<string, PersonaComparison>();
  const bump = (persona: string | null, key: 'actual' | 'candidate'): void => {
    if (!persona) return;
    const entry = per.get(persona) ?? { persona_id: persona, actual: 0, candidate: 0, delta: 0 };
    entry[key] += 1;
    per.set(persona, entry);
  };

  let projected = 0;
  let unprojectable = 0;
  let breaches_before = 0;
  let breaches_after = 0;
  const unprojectableReasons: Record<string, number> = {};

  const outcome_shift = {
    ASSIGNED: { actual: 0, candidate: 0 },
    FALLBACK: { actual: 0, candidate: 0 },
    REVIEW: { actual: 0, candidate: 0 },
    UNROUTABLE: { actual: 0, candidate: 0 },
  } as SimulationReport['outcome_shift'];
  const changed: SimulationReport['changed'] = [];

  try {
    for (const past of history) {
      bump(past.chosen_persona_id, 'actual');
      outcome_shift[past.outcome].actual += 1;

      /*
       * The subject is reconstructed from the trace rather than re-fetched: the
       * subject's own fields may have changed since, and replaying today's version of
       * it would answer a question nobody asked. What was recorded is what the rules
       * saw.
       */
      const subject = reconstructSubject(past);
      const replay = await route({
        tenant_id: input.tenant_id,
        subject_ref: past.subject_ref,
        subject,
        candidate_persona_ids: input.candidate_persona_ids,
        persona_specialties: input.persona_specialties,
        at: new Date(past.created_at),
        rule_set_name: input.rule_set_name,
        rule_set_version: input.candidate_version,
        dry_run: true,
      });

      bump(replay.chosen_persona_id, 'candidate');
      outcome_shift[replay.outcome].candidate += 1;

      if (slaProjector) {
        /*
         * READ-ONLY, and it has to stay that way: this runs inside the swapped-sink
         * window, so a projector that started a clock would be counted in
         * side_effects.clocks and the report would show its own violation rather than
         * hiding it. A projector that THROWS is treated as unprojectable for that one
         * subject rather than failing the whole simulation — one unreadable calendar
         * should not cost a reviewer the other 199 subjects.
         */
        let verdict: SlaProjectionVerdict | null = null;
        try {
          verdict = await slaProjector({
            tenant_id: input.tenant_id,
            subject_ref: past.subject_ref,
            at: new Date(past.created_at),
            actual_persona_id: past.chosen_persona_id,
            candidate_persona_id: replay.chosen_persona_id,
            candidate_outcome: replay.outcome,
          });
        } catch (err) {
          verdict = null;
          bumpReason(unprojectableReasons, `projector_error: ${(err as Error).message}`);
        }
        if (!verdict || verdict.candidate_breached === null) {
          unprojectable += 1;
          if (verdict) bumpReason(unprojectableReasons, verdict.reason);
          else if (!unprojectableReasons.projector_error) bumpReason(unprojectableReasons, 'no_clock_or_policy');
        } else {
          projected += 1;
          if (verdict.actual_breached) breaches_before += 1;
          if (verdict.candidate_breached) breaches_after += 1;
        }
      }
      if (replay.chosen_persona_id !== past.chosen_persona_id || replay.outcome !== past.outcome) {
        changed.push({
          subject_ref: past.subject_ref,
          actual_persona_id: past.chosen_persona_id,
          candidate_persona_id: replay.chosen_persona_id,
          actual_outcome: past.outcome,
          candidate_outcome: replay.outcome,
        });
      }
    }
  } finally {
    sinks = original;
  }

  const decisionsAfter = await countDecisions(input.tenant_id);
  const per_persona = [...per.values()].map((p) => ({ ...p, delta: p.candidate - p.actual }))
    .sort((a, b) => b.candidate - a.candidate);
  const skew_tolerance = input.skew_tolerance ?? 0.5;

  const body = {
    candidate_version: input.candidate_version,
    subjects_replayed: history.length,
    per_persona,
    outcome_shift,
    changed,
    skew: auditSkew(per_persona, input.candidate_persona_ids, skew_tolerance),
    // Omitted entirely when unwired — see setSlaProjector for why an absent section
    // beats a zeroed one.
    ...(slaProjector
      ? {
          sla_projection: {
            projected,
            unprojectable,
            unprojectable_reasons: unprojectableReasons,
            breaches_before,
            breaches_after,
            delta: breaches_after - breaches_before,
          } satisfies SlaProjection,
        }
      : {}),
    side_effects: {
      ...counted,
      /*
       * Counted from the table, not assumed: the dry_run flag could regress. Note the
       * count is over assignment.routing_decision ONLY — recording the run itself in
       * simulation_run below is not a routing effect and must not show up here, or the
       * number stops meaning "nothing was routed" and starts meaning nothing at all.
       */
      decisions_written: decisionsAfter - decisionsBefore,
    },
  };

  const simulation_id = await recordRun(input, body, skew_tolerance);
  return { simulation_id, ...body };
}

/**
 * Persist the run and return its id.
 *
 * The inputs are stored ALONGSIDE the report rather than folded into it: the report is
 * the answer and these are the question, and an answer whose question was discarded can
 * be believed but never checked. `report` holds the body verbatim, denormalised on
 * purpose — re-deriving it later would replay against history and rules that have since
 * moved, which is the exact failure this table exists to prevent.
 */
async function recordRun(
  input: SimulateInput,
  body: Omit<SimulationReport, 'simulation_id'>,
  skew_tolerance: number,
): Promise<string> {
  const row = await dataService.one<{ simulation_id: string }>(
    `INSERT INTO assignment.simulation_run
       (tenant_id, candidate_version, rule_set_name, window_from, window_to,
        candidate_persona_ids, skew_tolerance, subjects_replayed, report)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9::jsonb)
     RETURNING simulation_id`,
    [
      input.tenant_id,
      input.candidate_version,
      input.rule_set_name ?? null,
      input.from ?? null,
      input.to ?? null,
      input.candidate_persona_ids,
      skew_tolerance,
      body.subjects_replayed,
      JSON.stringify(body),
    ],
  );
  if (!row) {
    // The report is worthless as evidence if nobody can reach it again, so a failed
    // record fails the call rather than handing back an un-citable body.
    throw new Error('simulate: the run could not be recorded, so the report has no citable id');
  }
  return row.simulation_id;
}

/** Re-open a recorded run by the id a proposal cited. */
export async function getSimulationRun(
  tenant_id: string, simulation_id: string,
): Promise<(SimulationReport & { created_at: Date }) | null> {
  const row = await dataService.one<{
    simulation_id: string; report: Omit<SimulationReport, 'simulation_id'>; created_at: Date;
  }>(
    `SELECT simulation_id, report, created_at
       FROM assignment.simulation_run
      WHERE tenant_id = $1 AND simulation_id = $2`,
    [tenant_id, simulation_id],
  );
  if (!row) return null;
  return { simulation_id: row.simulation_id, ...row.report, created_at: row.created_at };
}

export interface SimulationRunSummary {
  simulation_id: string;
  candidate_version: number;
  rule_set_name: string | null;
  subjects_replayed: number;
  created_at: Date;
}

/** The list a reviewer opens: this tenant's runs, newest first. */
export async function listSimulationRuns(filter: {
  tenant_id: string;
  rule_set_name?: string;
  candidate_version?: number;
  limit?: number;
}): Promise<SimulationRunSummary[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  return dataService.rows<SimulationRunSummary>(
    `SELECT simulation_id, candidate_version, rule_set_name, subjects_replayed, created_at
       FROM assignment.simulation_run
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR rule_set_name = $2)
        AND ($3::int IS NULL OR candidate_version = $3)
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    [filter.tenant_id, filter.rule_set_name ?? null, filter.candidate_version ?? null],
  );
}

/**
 * Over-allocation AND starvation, reported separately.
 *
 * They have different causes — one persona matching too many rules versus one matching
 * none — and different fixes, and a single "imbalance" number hides the person who got
 * nothing at all. `received_nothing` is called out on its own because zero is the case
 * a ratio cannot express usefully.
 */
export function auditSkew(
  per_persona: PersonaComparison[], eligible_persona_ids: string[], tolerance: number,
): SkewAudit {
  const counts = new Map(per_persona.map((p) => [p.persona_id, p.candidate]));
  for (const persona of eligible_persona_ids) {
    if (!counts.has(persona)) counts.set(persona, 0);
  }
  const values = [...counts.values()];
  const total = values.reduce((a, b) => a + b, 0);
  const mean = values.length ? total / values.length : 0;

  const over: SkewAudit['over_allocated'] = [];
  const under: SkewAudit['starved'] = [];
  const nothing: string[] = [];

  for (const [persona_id, count] of counts) {
    if (count === 0) nothing.push(persona_id);
    if (mean === 0) continue;
    const ratio = count / mean;
    if (ratio >= 1 + tolerance) over.push({ persona_id, count, ratio: round(ratio) });
    else if (ratio <= 1 - tolerance) under.push({ persona_id, count, ratio: round(ratio) });
  }

  return {
    mean: round(mean),
    over_allocated: over.sort((a, b) => b.ratio - a.ratio),
    starved: under.sort((a, b) => a.ratio - b.ratio),
    received_nothing: nothing,
  };
}

/* -------------------------------------------------------------- helpers */

const round = (n: number): number => Math.round(n * 100) / 100;

const bumpReason = (into: Record<string, number>, reason: string): void => {
  into[reason] = (into[reason] ?? 0) + 1;
};

async function countDecisions(tenant_id: string): Promise<number> {
  const row = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM assignment.routing_decision WHERE tenant_id = $1`,
    [tenant_id],
  );
  return Number(row?.n ?? 0);
}

/**
 * Rebuild what the rules saw, from the trace they left.
 *
 * The trace records the values each predicate read, which is exactly the subset of the
 * subject that mattered. Anything a candidate rule reads that the original did not is
 * genuinely unknown — and the pipeline treats an unknown field as AMBIGUOUS, which
 * sends it to review. That is the honest answer: a candidate rule set that reads new
 * fields cannot be evaluated against history that never carried them, and a simulation
 * that quietly defaulted them would report a confident number about nothing.
 */
function reconstructSubject(past: HistoricalDecision): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  for (const step of past.steps ?? []) {
    const detail = step.detail as { subject_fields?: Record<string, unknown> } | undefined;
    if (detail?.subject_fields) Object.assign(subject, detail.subject_fields);
  }
  return subject;
}

/** Read the fair-share rotation state WITHOUT advancing it (EP-335 owns the cursor). */
export async function readRotationState(input: {
  tenant_id: string; pool_key?: string; strategy?: string;
}): Promise<Array<{ pool_key: string; strategy: string; rotation_index: number }>> {
  return dataService.rows(
    `SELECT pool_key, strategy, rotation_index
       FROM assignment.rotation_cursor
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR pool_key = $2)
        AND ($3::text IS NULL OR strategy = $3)
      ORDER BY pool_key, strategy`,
    [input.tenant_id, input.pool_key ?? null, input.strategy ?? null],
  );
}
