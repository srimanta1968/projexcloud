import { dataService } from '@projexlight/db-runtime';

/**
 * The six-step routing pipeline, and the trace that explains it (P16 · EP-379).
 *
 * Steps, always in this order:
 *   1. ELIGIBILITY  — is this subject routable at all?
 *   2. PRIORITY     — which band does it belong to?
 *   3. SPECIALTY    — who is qualified?
 *   4. AVAILABILITY — of those, who can act right now? (delegated to sdk-coverage)
 *   5. ASSIGNMENT   — pick one.
 *   6. FALLBACK     — and if nobody, who catches it?
 *
 * TWO THINGS THIS FILE IS BUILT AROUND.
 *
 * First, AMBIGUITY GOES TO A HUMAN. When eligibility cannot be decided — a predicate
 * references a field the subject does not carry, or two rules give opposite answers —
 * the outcome is REVIEW. Never a guess, and never "assign anyway and let somebody
 * notice". A forced assignment on ambiguous input looks exactly like a correct one in
 * every dashboard, so the error is invisible precisely when it matters.
 *
 * Second, THE TRACE IS THE PRODUCT. Every step records what it looked at, what it
 * decided and a plain-language sentence, and the whole thing is written down with the
 * decision. An operator asking "why did this go there" is asking about a decision that
 * already happened; re-running the pipeline today would answer a different question,
 * because the rules and everybody's availability have moved on since.
 *
 * Availability is DELEGATED, never reimplemented: sdk-coverage owns "who can act right
 * now" and this file reaches it through a registered resolver rather than an import,
 * so the routing kernel stays independent of what it routes to.
 */

export type RoutingOutcome = 'ASSIGNED' | 'FALLBACK' | 'REVIEW' | 'UNROUTABLE';
export type StepName =
  | 'eligibility' | 'priority' | 'specialty' | 'availability' | 'assignment' | 'fallback';

export interface TraceStep {
  step: StepName;
  /** What the step concluded, in one sentence an operator can read. */
  explanation: string;
  /** Machine-readable outcome of this step. */
  result: 'pass' | 'review' | 'skip' | 'fail';
  /** Candidates still standing after this step, when the step narrows them. */
  candidates?: string[];
  /** Anything the step needs to justify itself: the rule it matched, the value it read. */
  detail?: Record<string, unknown>;
}

export interface RoutingResult {
  outcome: RoutingOutcome;
  chosen_persona_id: string | null;
  priority_band: string | null;
  trace: TraceStep[];
  rule_set_version: number | null;
  decision_id: string | null;
  took_ms: number;
}

/* ------------------------------------------------------ versioned rules */

export interface EligibilityRule {
  /** Field on the subject this predicate reads. */
  field: string;
  op: 'present' | 'equals' | 'in' | 'gte' | 'lte';
  value?: unknown;
  /** Said back to the operator when this predicate decides the outcome. */
  because?: string;
}

export interface PriorityBandRule {
  band: string;
  when?: EligibilityRule[];
}

export interface RuleSetBody {
  eligibility?: EligibilityRule[];
  priority_bands?: PriorityBandRule[];
  specialty?: { field?: string; required?: boolean };
  availability?: { ignore_presence?: boolean; band_from_priority?: boolean };
  assignment?: { pick?: 'first' | 'most_headroom' };
  fallback?: { persona_id?: string; role_ref?: string; to_review?: boolean };
}

export interface RuleSet {
  rule_set_id: string;
  tenant_id: string;
  name: string;
  version: number;
  rules: RuleSetBody;
  is_active: boolean;
}

const RULE_SET_COLS = `rule_set_id, tenant_id, name, version, rules, is_active`;

export class RuleSetNotFound extends Error {
  readonly code = 'ROUTING_RULE_SET_NOT_FOUND';
  constructor(tenant_id: string, name: string) {
    super(`no active routing rule set '${name}' for this tenant`);
    this.name = 'RuleSetNotFound';
  }
}

/**
 * Publish a NEW version. Never an edit: a decision's trace names the version that
 * produced it, and an editable version would explain last month's decision with this
 * month's rules — a confident wrong answer, which is worse than none.
 */
export async function publishRuleSet(input: {
  tenant_id: string;
  rules: RuleSetBody;
  name?: string;
  published_by?: string;
  activate?: boolean;
}): Promise<RuleSet> {
  const name = input.name ?? 'default';
  return dataService.tx(async (q) => {
    const next = await q<{ version: string }>(
      `SELECT COALESCE(max(version), 0) + 1 AS version
         FROM assignment.routing_rule_set WHERE tenant_id = $1 AND name = $2`,
      [input.tenant_id, name],
    );
    const version = Number(next.rows[0].version);
    if (input.activate) {
      await q(
        `UPDATE assignment.routing_rule_set SET is_active = false, activated_at = NULL
          WHERE tenant_id = $1 AND name = $2 AND is_active`,
        [input.tenant_id, name],
      );
    }
    const row = await q<RuleSet & { rules: RuleSetBody }>(
      `INSERT INTO assignment.routing_rule_set
          (tenant_id, name, version, rules, is_active, activated_at, published_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, CASE WHEN $5 THEN now() END, $6)
       RETURNING ${RULE_SET_COLS}`,
      [
        input.tenant_id, name, version, JSON.stringify(input.rules ?? {}),
        input.activate ?? false, input.published_by ?? null,
      ],
    );
    return row.rows[0];
  });
}

/** Switch which published version is in force. No deploy, no code change. */
export async function activateRuleSet(input: {
  tenant_id: string; version: number; name?: string;
}): Promise<RuleSet> {
  const name = input.name ?? 'default';
  return dataService.tx(async (q) => {
    await q(
      `UPDATE assignment.routing_rule_set SET is_active = false, activated_at = NULL
        WHERE tenant_id = $1 AND name = $2 AND is_active`,
      [input.tenant_id, name],
    );
    const row = await q<RuleSet>(
      `UPDATE assignment.routing_rule_set
          SET is_active = true, activated_at = now()
        WHERE tenant_id = $1 AND name = $2 AND version = $3
        RETURNING ${RULE_SET_COLS}`,
      [input.tenant_id, name, input.version],
    );
    if (row.rows.length === 0) throw new RuleSetNotFound(input.tenant_id, name);
    return row.rows[0];
  });
}

export async function getActiveRuleSet(
  tenant_id: string, name = 'default',
): Promise<RuleSet | null> {
  return dataService.one<RuleSet>(
    `SELECT ${RULE_SET_COLS} FROM assignment.routing_rule_set
      WHERE tenant_id = $1 AND name = $2 AND is_active`,
    [tenant_id, name],
  );
}

export async function getRuleSetVersion(
  tenant_id: string, version: number, name = 'default',
): Promise<RuleSet | null> {
  return dataService.one<RuleSet>(
    `SELECT ${RULE_SET_COLS} FROM assignment.routing_rule_set
      WHERE tenant_id = $1 AND name = $2 AND version = $3`,
    [tenant_id, name, version],
  );
}

export async function listRuleSetVersions(
  tenant_id: string, name = 'default',
): Promise<RuleSet[]> {
  return dataService.rows<RuleSet>(
    `SELECT ${RULE_SET_COLS} FROM assignment.routing_rule_set
      WHERE tenant_id = $1 AND name = $2 ORDER BY version DESC`,
    [tenant_id, name],
  );
}

/* ------------------------------------------------ the availability seam */

export interface AvailabilityQuery {
  tenant_id: string;
  persona_ids: string[];
  at: Date;
  band?: string;
  ignore_presence?: boolean;
}

export interface AvailabilityAnswer {
  eligible: Array<{ persona_id: string; min_remaining_headroom: number | null }>;
  ineligible: Array<{ persona_id: string; reasons: Array<{ code: string; detail: string }> }>;
}

export type AvailabilityResolver = (q: AvailabilityQuery) => Promise<AvailabilityAnswer>;

let availabilityResolver: AvailabilityResolver | null = null;

/**
 * Wire sdk-coverage's GET /api/coverage/eligible (or its findEligible directly).
 *
 * NO DEFAULT. A default that treated everybody as available would route work to
 * people on PTO and at capacity, and the first sign would be an unanswered subject.
 * Unwired, the availability step reports that it could not be evaluated and the
 * pipeline goes to REVIEW — visible, rather than confidently wrong.
 */
export function setAvailabilityResolver(fn: AvailabilityResolver | null): void {
  availabilityResolver = fn;
}

export function hasAvailabilityResolver(): boolean {
  return availabilityResolver !== null;
}

/* ------------------------------------------------------- the predicates */

interface PredicateVerdict {
  ok: boolean;
  /** True when the predicate could not be decided from the subject at all. */
  ambiguous: boolean;
  explanation: string;
}

function evaluatePredicate(rule: EligibilityRule, subject: Record<string, unknown>): PredicateVerdict {
  const present = Object.prototype.hasOwnProperty.call(subject, rule.field);
  const value = subject[rule.field];

  if (rule.op === 'present') {
    return {
      ok: present && value !== null && value !== '',
      ambiguous: false,
      explanation: present
        ? `'${rule.field}' is present`
        : `'${rule.field}' is missing`,
    };
  }

  if (!present || value === null) {
    /*
     * The subject does not carry the field this rule reads. That is NOT "false" — a
     * rule asking "is the region TX" cannot be answered by a subject with no region,
     * and answering "no" quietly routes it to whoever catches the default.
     */
    return {
      ok: false,
      ambiguous: true,
      explanation: `cannot evaluate '${rule.field}' ${rule.op}: the subject does not carry that field`,
    };
  }

  switch (rule.op) {
    case 'equals':
      return { ok: value === rule.value, ambiguous: false,
        explanation: `'${rule.field}' is ${JSON.stringify(value)}, rule wants ${JSON.stringify(rule.value)}` };
    case 'in': {
      const set = Array.isArray(rule.value) ? rule.value : [];
      return { ok: set.includes(value as never), ambiguous: false,
        explanation: `'${rule.field}' is ${JSON.stringify(value)}, rule allows ${JSON.stringify(set)}` };
    }
    case 'gte':
    case 'lte': {
      const left = Number(value);
      const right = Number(rule.value);
      if (Number.isNaN(left) || Number.isNaN(right)) {
        return { ok: false, ambiguous: true,
          explanation: `cannot compare '${rule.field}' (${JSON.stringify(value)}) numerically` };
      }
      const ok = rule.op === 'gte' ? left >= right : left <= right;
      return { ok, ambiguous: false,
        explanation: `'${rule.field}' is ${left}, rule wants ${rule.op === 'gte' ? '>=' : '<='} ${right}` };
    }
    default:
      // An operator this build does not know is ambiguity, not falsehood: the rule
      // was written by somebody who meant something by it.
      return { ok: false, ambiguous: true,
        explanation: `unknown predicate operator '${String((rule as { op: string }).op)}'` };
  }
}

/**
 * The subject fields this rule set reads, and their values — nothing else.
 */
function readFields(
  rules: RuleSetBody, subject: Record<string, unknown>,
): Record<string, unknown> {
  const fields = new Set<string>();
  for (const rule of rules.eligibility ?? []) fields.add(rule.field);
  for (const band of rules.priority_bands ?? []) {
    for (const when of band.when ?? []) fields.add(when.field);
  }
  if (rules.specialty?.field) fields.add(rules.specialty.field);

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(subject, field)) out[field] = subject[field];
  }
  return out;
}

/* -------------------------------------------------------- the pipeline */

export interface RouteInput {
  tenant_id: string;
  subject_ref: string;
  /** The subject's own fields, whatever they are. Rules read them by name. */
  subject: Record<string, unknown>;
  candidate_persona_ids: string[];
  /** Specialties per candidate, when the tenant routes by specialty. */
  persona_specialties?: Record<string, string[]>;
  at?: Date;
  rule_set_name?: string;
  /**
   * Evaluate against a SPECIFIC published version rather than the active one. The
   * simulation lane needs this: comparing a candidate against history means running
   * rules that are deliberately NOT in force, and activating them to try them out is
   * the experiment changing production.
   */
  rule_set_version?: number;
  /** Skip persisting the decision — used by the simulation lane. */
  dry_run?: boolean;
}

export async function route(input: RouteInput): Promise<RoutingResult> {
  const startedAt = Date.now();
  const at = input.at ?? new Date();
  const trace: TraceStep[] = [];
  const ruleSet = input.rule_set_version === undefined
    ? await getActiveRuleSet(input.tenant_id, input.rule_set_name ?? 'default')
    : await getRuleSetVersion(input.tenant_id, input.rule_set_version, input.rule_set_name ?? 'default');
  const rules: RuleSetBody = ruleSet?.rules ?? {};

  const finish = async (
    outcome: RoutingOutcome, chosen: string | null, band: string | null,
  ): Promise<RoutingResult> => {
    const took_ms = Date.now() - startedAt;
    let decision_id: string | null = null;
    if (!input.dry_run) {
      const row = await dataService.one<{ decision_id: string }>(
        `INSERT INTO assignment.routing_decision
            (tenant_id, subject_ref, rule_set_id, rule_set_version, outcome,
             chosen_persona_id, steps, took_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING decision_id`,
        [
          input.tenant_id, input.subject_ref, ruleSet?.rule_set_id ?? null,
          ruleSet?.version ?? null, outcome, chosen, JSON.stringify(trace), took_ms,
        ],
      );
      decision_id = row?.decision_id ?? null;
    }
    return {
      outcome, chosen_persona_id: chosen, priority_band: band, trace,
      rule_set_version: ruleSet?.version ?? null, decision_id, took_ms,
    };
  };

  /* 1. ELIGIBILITY */
  const eligibility = rules.eligibility ?? [];
  const ambiguities: string[] = [];
  const failures: string[] = [];
  for (const rule of eligibility) {
    const verdict = evaluatePredicate(rule, input.subject);
    if (verdict.ambiguous) ambiguities.push(rule.because ?? verdict.explanation);
    else if (!verdict.ok) failures.push(rule.because ?? verdict.explanation);
  }
  if (ambiguities.length > 0) {
    trace.push({
      step: 'eligibility',
      result: 'review',
      explanation:
        `Sent to review rather than routed: ${ambiguities.length} eligibility rule(s) could not be ` +
        `decided from this subject — ${ambiguities.join('; ')}.`,
      detail: { ambiguous: ambiguities, rule_count: eligibility.length },
    });
    // Deliberately NOT a guess. A forced assignment on ambiguous input looks
    // identical to a correct one in every dashboard.
    return finish('REVIEW', null, null);
  }
  if (failures.length > 0) {
    trace.push({
      step: 'eligibility',
      result: 'fail',
      explanation: `Not routable: ${failures.join('; ')}.`,
      detail: { failed: failures },
    });
    return finish('UNROUTABLE', null, null);
  }
  trace.push({
    step: 'eligibility',
    result: 'pass',
    explanation: eligibility.length
      ? `Passed all ${eligibility.length} eligibility rule(s).`
      : 'No eligibility rules are configured, so every subject is routable.',
    candidates: input.candidate_persona_ids,
    /*
     * The subject fields the rules actually READ, recorded with the decision. This is
     * what lets a simulation replay history honestly: the subject itself may have
     * changed since, and re-fetching it would answer a question nobody asked. Only the
     * fields that mattered are kept — the trace is an explanation, not a copy of the
     * subject, and copying the whole thing would quietly duplicate whatever PII it
     * carries into a table nobody thinks of as sensitive.
     */
    detail: { subject_fields: readFields(rules, input.subject) },
  });

  /* 2. PRIORITY BAND */
  let band: string | null = null;
  for (const rule of rules.priority_bands ?? []) {
    const conditions = rule.when ?? [];
    const verdicts = conditions.map((c) => evaluatePredicate(c, input.subject));
    if (verdicts.some((v) => v.ambiguous)) {
      trace.push({
        step: 'priority',
        result: 'review',
        explanation:
          `Sent to review: the '${rule.band}' band condition could not be decided — ` +
          `${verdicts.filter((v) => v.ambiguous).map((v) => v.explanation).join('; ')}.`,
      });
      return finish('REVIEW', null, null);
    }
    if (verdicts.every((v) => v.ok)) { band = rule.band; break; }
  }
  trace.push({
    step: 'priority',
    result: band ? 'pass' : 'skip',
    explanation: band
      ? `Priority band '${band}'.`
      : 'No priority band matched; the subject is treated as unbanded.',
    detail: { band },
  });

  /* 3. SPECIALTY */
  let candidates = [...input.candidate_persona_ids];
  const specialtyField = rules.specialty?.field;
  if (specialtyField) {
    const required = input.subject[specialtyField];
    const wanted = Array.isArray(required) ? required : required === undefined ? [] : [required];
    if (wanted.length === 0 && rules.specialty?.required) {
      trace.push({
        step: 'specialty',
        result: 'review',
        explanation:
          `Sent to review: routing requires a specialty and the subject's '${specialtyField}' is empty.`,
      });
      return finish('REVIEW', null, null);
    }
    if (wanted.length > 0) {
      const before = candidates.length;
      candidates = candidates.filter((persona) =>
        (input.persona_specialties?.[persona] ?? []).some((s) => wanted.includes(s)));
      trace.push({
        step: 'specialty',
        result: candidates.length > 0 ? 'pass' : 'fail',
        explanation: candidates.length > 0
          ? `${candidates.length} of ${before} candidate(s) hold ${JSON.stringify(wanted)}.`
          : `No candidate holds ${JSON.stringify(wanted)}.`,
        candidates,
        detail: { required: wanted },
      });
    } else {
      trace.push({ step: 'specialty', result: 'skip',
        explanation: 'The subject names no specialty, so no candidate was excluded.',
        candidates });
    }
  } else {
    trace.push({ step: 'specialty', result: 'skip',
      explanation: 'Specialty matching is not configured.', candidates });
  }

  /* 4. AVAILABILITY — delegated to sdk-coverage */
  let ranked: Array<{ persona_id: string; min_remaining_headroom: number | null }> = [];
  if (candidates.length === 0) {
    trace.push({ step: 'availability', result: 'skip',
      explanation: 'Skipped: no candidate reached this step.' });
  } else if (!availabilityResolver) {
    /*
     * Unwired is REVIEW, not "everybody is free". Assuming availability routes work
     * to people on PTO and at capacity, and the first sign is an unanswered subject.
     */
    trace.push({
      step: 'availability',
      result: 'review',
      explanation:
        'Sent to review: availability could not be checked because no coverage resolver is wired, ' +
        'and assuming everybody is free would route work to people who are not.',
    });
    return finish('REVIEW', null, null);
  } else {
    const answer = await availabilityResolver({
      tenant_id: input.tenant_id,
      persona_ids: candidates,
      at,
      band: rules.availability?.band_from_priority && band ? band : undefined,
      ignore_presence: rules.availability?.ignore_presence,
    });
    ranked = answer.eligible.filter((e) => candidates.includes(e.persona_id));
    const excluded = answer.ineligible
      .filter((i) => candidates.includes(i.persona_id))
      .map((i) => `${i.persona_id} (${i.reasons.map((r) => r.code).join(', ')})`);
    trace.push({
      step: 'availability',
      result: ranked.length > 0 ? 'pass' : 'fail',
      explanation: ranked.length > 0
        ? `${ranked.length} of ${candidates.length} candidate(s) can act right now.`
        : `Nobody can act right now${excluded.length ? `: ${excluded.join('; ')}` : ''}.`,
      candidates: ranked.map((r) => r.persona_id),
      // The REASONS are carried, not just the count: an operator asking why somebody
      // was skipped is asking exactly this.
      detail: { excluded },
    });
  }

  /* 5. ASSIGNMENT */
  if (ranked.length > 0) {
    const pick = rules.assignment?.pick ?? 'most_headroom';
    const chosen = pick === 'first'
      ? ranked[0]
      : [...ranked].sort((a, b) =>
          (b.min_remaining_headroom ?? Number.MAX_SAFE_INTEGER) -
          (a.min_remaining_headroom ?? Number.MAX_SAFE_INTEGER))[0];
    trace.push({
      step: 'assignment',
      result: 'pass',
      explanation: pick === 'first'
        ? `Assigned to ${chosen.persona_id}, the first available candidate in order.`
        : `Assigned to ${chosen.persona_id}, who has the most remaining headroom ` +
          `(${chosen.min_remaining_headroom ?? 'uncapped'}).`,
      detail: { strategy: pick },
    });
    return finish('ASSIGNED', chosen.persona_id, band);
  }
  trace.push({
    step: 'assignment',
    result: 'fail',
    explanation: 'No candidate was available to assign to.',
  });

  /* 6. FALLBACK */
  const fallback = rules.fallback ?? {};
  if (fallback.persona_id) {
    trace.push({
      step: 'fallback',
      result: 'pass',
      explanation: `Fell back to the configured catcher ${fallback.persona_id}.`,
      detail: { fallback_persona_id: fallback.persona_id },
    });
    return finish('FALLBACK', fallback.persona_id, band);
  }
  trace.push({
    step: 'fallback',
    result: fallback.to_review === false ? 'fail' : 'review',
    explanation: fallback.to_review === false
      ? 'No fallback is configured and review is disabled, so the subject is unroutable.'
      : 'No fallback persona is configured, so the subject goes to review rather than nowhere.',
  });
  return finish(fallback.to_review === false ? 'UNROUTABLE' : 'REVIEW', null, band);
}

/* ------------------------------------------------------------ reading */

export interface PersistedDecision {
  decision_id: string;
  subject_ref: string;
  outcome: RoutingOutcome;
  chosen_persona_id: string | null;
  rule_set_version: number | null;
  steps: TraceStep[];
  created_at: string;
}

export async function getDecision(
  tenant_id: string, decision_id: string,
): Promise<PersistedDecision | null> {
  const row = await dataService.one<PersistedDecision & { created_at: Date }>(
    `SELECT decision_id, subject_ref, outcome, chosen_persona_id, rule_set_version, steps, created_at
       FROM assignment.routing_decision WHERE tenant_id = $1 AND decision_id = $2`,
    [tenant_id, decision_id],
  );
  return row ? { ...row, created_at: new Date(row.created_at).toISOString() } : null;
}

export async function listDecisions(filter: {
  tenant_id: string; subject_ref?: string; outcome?: RoutingOutcome; limit?: number;
}): Promise<PersistedDecision[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const rows = await dataService.rows<PersistedDecision & { created_at: Date }>(
    `SELECT decision_id, subject_ref, outcome, chosen_persona_id, rule_set_version, steps, created_at
       FROM assignment.routing_decision
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR subject_ref = $2)
        AND ($3::text IS NULL OR outcome = $3)
      ORDER BY created_at DESC LIMIT ${limit}`,
    [filter.tenant_id, filter.subject_ref ?? null, filter.outcome ?? null],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}
