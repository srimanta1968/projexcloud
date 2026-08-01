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

export interface PersonaComparison {
  persona_id: string;
  actual: number;
  candidate: number;
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

  return {
    candidate_version: input.candidate_version,
    subjects_replayed: history.length,
    per_persona,
    outcome_shift,
    changed,
    skew: auditSkew(per_persona, input.candidate_persona_ids, input.skew_tolerance ?? 0.5),
    side_effects: {
      ...counted,
      // Counted from the table, not assumed: the dry_run flag could regress.
      decisions_written: decisionsAfter - decisionsBefore,
    },
  };
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
