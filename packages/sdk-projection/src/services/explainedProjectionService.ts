import { dataService } from '@projexlight/db-runtime';
import {
  resolveSurvivorshipRules,
  type SurvivorshipCriterion,
  type SurvivorshipRuleSet,
} from './survivorshipRuleService';

/**
 * Explained projection (P16 · EP-382).
 *
 * Returns the surviving value per attribute AND every losing assertion with a CONCRETE
 * reason it lost.
 *
 * "Concrete" is the whole requirement. A status word — superseded, stale, outranked —
 * tells a user nothing they can act on: they cannot see whether the import beat their
 * correction because of precedence they would agree with, or because someone set a
 * confidence wrong. So each loss names the criterion that decided it, the two values
 * compared, and where that criterion sits in the rule order:
 *
 *   "lost on origin_class (criterion 2 of 4): 'import' ranks below 'user_supplied'"
 *
 * That sentence is enough to either accept the outcome or find the misconfiguration.
 *
 * Losing assertions are never deleted or mutated (AC3) — losing is COMPUTED on read, so
 * the same rows re-explain themselves under a changed rule set, and a rule change is a
 * projection change rather than a data migration.
 */

export interface AssertionRecord {
  assertion_id: string;
  tenant_id: string;
  subject_ref: string;
  attribute: string;
  value: string;
  origin_class: string;
  origin_ref: string | null;
  confidence: number;
  verification_state: 'unverified' | 'verified' | 'rejected';
  verified_at: string | null;
  observed_at: string;
  recorded_at: string;
  retracted_at: string | null;
  superseded_by: string | null;
  metadata: Record<string, unknown>;
}

export interface LosingAssertion {
  assertion: AssertionRecord;
  /** The full sentence. Never a bare status word. */
  reason: string;
  /** The criterion that decided it, for callers that would rather format their own text. */
  decided_by: {
    criterion: string;
    /** 1-based position in the rule order, so "why did origin not matter" is answerable. */
    criterion_index: number;
    losing_value: string | number;
    winning_value: string | number;
  };
}

export interface ExplainedAttribute {
  attribute: string;
  surviving_value: string | null;
  surviving_assertion: AssertionRecord | null;
  losing: LosingAssertion[];
  /** Which rule set decided this attribute — tenant, platform or builtin. */
  rules: SurvivorshipRuleSet;
}

export interface ExplainedProjection {
  tenant_id: string;
  subject_ref: string;
  attributes: ExplainedAttribute[];
  /** Retracted/rejected inputs are excluded from the contest but remain queryable. */
  excluded_count: number;
  projected_at: string;
}

interface AssertionRow {
  assertion_id: string;
  tenant_id: string;
  subject_ref: string;
  attribute: string;
  value: string;
  origin_class: string;
  origin_ref: string | null;
  confidence: string;
  verification_state: string;
  verified_at: Date | null;
  observed_at: Date;
  recorded_at: Date;
  retracted_at: Date | null;
  superseded_by: string | null;
  metadata: Record<string, unknown> | null;
}

const ASSERTION_COLUMNS = `
  assertion_id::text, tenant_id::text, subject_ref, attribute, value, origin_class,
  origin_ref, confidence::text, verification_state, verified_at, observed_at,
  recorded_at, retracted_at, superseded_by::text, metadata`;

function rowToAssertion(r: AssertionRow): AssertionRecord {
  return {
    assertion_id: r.assertion_id,
    tenant_id: r.tenant_id,
    subject_ref: r.subject_ref,
    attribute: r.attribute,
    value: r.value,
    origin_class: r.origin_class,
    origin_ref: r.origin_ref,
    confidence: Number(r.confidence),
    verification_state: r.verification_state as AssertionRecord['verification_state'],
    verified_at: r.verified_at ? r.verified_at.toISOString() : null,
    observed_at: r.observed_at.toISOString(),
    recorded_at: r.recorded_at.toISOString(),
    retracted_at: r.retracted_at ? r.retracted_at.toISOString() : null,
    superseded_by: r.superseded_by,
    metadata: r.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Rank an enumerated value. Anything not listed sorts AFTER everything listed rather than
 * throwing: a new origin_class appearing in the data must not break the whole projection,
 * and ranking it last is the conservative reading of "the rules do not mention this".
 */
function rankOf(order: string[] | undefined, value: string): number {
  if (!order) return 0;
  const i = order.indexOf(value);
  return i === -1 ? order.length : i;
}

function criterionValue(a: AssertionRecord, c: SurvivorshipCriterion): string | number {
  switch (c.criterion) {
    case 'verification_state': return a.verification_state;
    case 'origin_class': return a.origin_class;
    case 'confidence': return a.confidence;
    case 'recency': return Date.parse(a.observed_at);
  }
}

/**
 * Compare two assertions under one criterion.
 * Negative → `a` wins, positive → `b` wins, 0 → tied on this criterion.
 */
function compareOn(a: AssertionRecord, b: AssertionRecord, c: SurvivorshipCriterion): number {
  if (c.criterion === 'verification_state' || c.criterion === 'origin_class') {
    const av = c.criterion === 'verification_state' ? a.verification_state : a.origin_class;
    const bv = c.criterion === 'verification_state' ? b.verification_state : b.origin_class;
    return rankOf(c.order, av) - rankOf(c.order, bv); // lower index = better
  }
  const av = c.criterion === 'confidence' ? a.confidence : Date.parse(a.observed_at);
  const bv = c.criterion === 'confidence' ? b.confidence : Date.parse(b.observed_at);
  const diff = av - bv;
  return (c.direction ?? 'desc') === 'desc' ? -diff : diff;
}

function describeValue(v: string | number, c: SurvivorshipCriterion): string {
  if (c.criterion === 'recency') return new Date(v as number).toISOString();
  if (c.criterion === 'confidence') return String(v);
  return `'${v}'`;
}

/**
 * Why did `loser` lose to `winner`? Returns the FIRST criterion that separates them, which
 * is by definition the one that decided it — later criteria were never consulted.
 */
function explainLoss(
  winner: AssertionRecord,
  loser: AssertionRecord,
  criteria: SurvivorshipCriterion[],
): LosingAssertion['decided_by'] & { reason: string } {
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i];
    const cmp = compareOn(winner, loser, c);
    if (cmp === 0) continue;

    const wv = criterionValue(winner, c);
    const lv = criterionValue(loser, c);
    const pos = `criterion ${i + 1} of ${criteria.length}`;

    let reason: string;
    if (c.criterion === 'verification_state' || c.criterion === 'origin_class') {
      reason = `lost on ${c.criterion} (${pos}): ${describeValue(lv, c)} ranks below ${describeValue(wv, c)} in this tenant's order [${(c.order ?? []).join(' > ')}]`;
    } else if (c.criterion === 'confidence') {
      reason = `lost on confidence (${pos}): ${lv} is lower than the surviving assertion's ${wv}`;
    } else {
      reason = `lost on recency (${pos}): observed ${describeValue(lv, c)}, older than the surviving assertion's ${describeValue(wv, c)}`;
    }
    return { criterion: c.criterion, criterion_index: i + 1, losing_value: lv, winning_value: wv, reason };
  }

  // Identical on every criterion. The tie-break is the assertion_id, and saying so is more
  // useful than "tied" — it tells the reader the rules do not distinguish these at all,
  // which is usually a sign the rule set needs another criterion.
  return {
    criterion: 'deterministic_tiebreak',
    criterion_index: criteria.length + 1,
    losing_value: loser.assertion_id,
    winning_value: winner.assertion_id,
    reason: `tied on every configured criterion (${criteria.map((c) => c.criterion).join(', ')}); resolved by a stable assertion_id tie-break so the projection is reproducible — add a criterion if this pairing should be decided on merit`,
  };
}

/**
 * Total, stable ordering (AC4).
 *
 * The final comparison on assertion_id is what makes the result reproducible: without it,
 * two assertions equal on every criterion could come back in either order depending on how
 * Postgres returned the rows, and "the explained view is stable for identical inputs"
 * would hold only by luck.
 */
function sortByRules(list: AssertionRecord[], criteria: SurvivorshipCriterion[]): AssertionRecord[] {
  return [...list].sort((a, b) => {
    for (const c of criteria) {
      const cmp = compareOn(a, b, c);
      if (cmp !== 0) return cmp;
    }
    return a.assertion_id.localeCompare(b.assertion_id);
  });
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ExplainProjectionInput {
  tenant_id: string;
  subject_ref: string;
  /** Restrict to specific attributes; omit for all. */
  attributes?: string[];
  /**
   * Include retracted and rejected assertions in the CONTEST. Off by default — a retracted
   * claim should not win — but they are always RETURNED by listAssertions, so nothing is
   * hidden either way (AC3).
   */
  include_retracted?: boolean;
}

export async function explainProjection(
  input: ExplainProjectionInput,
): Promise<ExplainedProjection> {
  if (!input.tenant_id) throw new Error('[sdk-projection] explainProjection requires tenant_id');
  if (!input.subject_ref?.trim()) {
    throw new Error('[sdk-projection] explainProjection requires subject_ref');
  }

  const res = await dataService.query<AssertionRow>(
    `SELECT ${ASSERTION_COLUMNS}
       FROM projection.attribute_assertion
      WHERE tenant_id = $1::uuid
        AND subject_ref = $2
        AND ($3::text[] IS NULL OR attribute = ANY($3::text[]))
      ORDER BY attribute, assertion_id`,
    [input.tenant_id, input.subject_ref, input.attributes?.length ? input.attributes : null],
  );
  const all = res.rows.map(rowToAssertion);

  const eligible = input.include_retracted
    ? all
    : all.filter((a) => !a.retracted_at && a.verification_state !== 'rejected');
  const excluded_count = all.length - eligible.length;

  const byAttribute = new Map<string, AssertionRecord[]>();
  for (const a of eligible) {
    const list = byAttribute.get(a.attribute) ?? [];
    list.push(a);
    byAttribute.set(a.attribute, list);
  }

  const attributes: ExplainedAttribute[] = [];
  // Sorted so the response itself is byte-stable for identical inputs (AC4).
  for (const attribute of [...byAttribute.keys()].sort()) {
    const rules = await resolveSurvivorshipRules({ tenant_id: input.tenant_id, attribute });
    const ranked = sortByRules(byAttribute.get(attribute)!, rules.criteria);
    const winner = ranked[0] ?? null;

    const losing: LosingAssertion[] = ranked.slice(1).map((loser) => {
      const { reason, ...decided } = explainLoss(winner!, loser, rules.criteria);
      return { assertion: loser, reason, decided_by: decided };
    });

    attributes.push({
      attribute,
      surviving_value: winner ? winner.value : null,
      surviving_assertion: winner,
      losing,
      rules,
    });
  }

  return {
    tenant_id: input.tenant_id,
    subject_ref: input.subject_ref,
    attributes,
    excluded_count,
    projected_at: new Date().toISOString(),
  };
}

/**
 * Every assertion for a subject, winners and losers alike (AC3).
 *
 * Separate from explainProjection because "show me the losing ones" must not require
 * re-running the contest — losing assertions are ordinary rows and stay directly
 * queryable, including retracted ones.
 */
export async function listAssertions(input: {
  tenant_id: string;
  subject_ref?: string;
  attribute?: string;
  origin_class?: string;
  include_retracted?: boolean;
  limit?: number;
  offset?: number;
}): Promise<AssertionRecord[]> {
  const res = await dataService.query<AssertionRow>(
    `SELECT ${ASSERTION_COLUMNS}
       FROM projection.attribute_assertion
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR subject_ref = $2)
        AND ($3::text IS NULL OR attribute = $3)
        AND ($4::text IS NULL OR origin_class = $4)
        AND ($5::boolean IS TRUE OR retracted_at IS NULL)
      ORDER BY subject_ref, attribute, observed_at DESC, assertion_id
      LIMIT $6 OFFSET $7`,
    [
      input.tenant_id,
      input.subject_ref ?? null,
      input.attribute ?? null,
      input.origin_class ?? null,
      input.include_retracted ?? false,
      Math.min(Math.max(input.limit ?? 200, 1), 1000),
      Math.max(input.offset ?? 0, 0),
    ],
  );
  return res.rows.map(rowToAssertion);
}

export interface RecordAssertionInput {
  tenant_id: string;
  subject_ref: string;
  attribute: string;
  value: string;
  origin_class: string;
  origin_ref?: string | null;
  confidence?: number;
  verification_state?: 'unverified' | 'verified' | 'rejected';
  observed_at?: string | Date;
  metadata?: Record<string, unknown>;
}

export async function recordAssertion(input: RecordAssertionInput): Promise<AssertionRecord> {
  const verification = input.verification_state ?? 'unverified';
  const row = await dataService.one<AssertionRow>(
    `INSERT INTO projection.attribute_assertion
       (tenant_id, subject_ref, attribute, value, origin_class, origin_ref,
        confidence, verification_state, verified_at, observed_at, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8 = 'verified' THEN now() ELSE NULL END,
             COALESCE($9::timestamptz, now()),
             COALESCE($10::jsonb, '{}'::jsonb))
     RETURNING ${ASSERTION_COLUMNS}`,
    [
      input.tenant_id,
      input.subject_ref,
      input.attribute,
      input.value,
      input.origin_class,
      input.origin_ref ?? null,
      input.confidence ?? 1,
      verification,
      input.observed_at ? new Date(input.observed_at).toISOString() : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!row) throw new Error('[sdk-projection] recordAssertion insert failed');
  return rowToAssertion(row);
}

/** Retract without deleting — the row still explains a past projection. */
export async function retractAssertion(input: {
  tenant_id: string;
  assertion_id: string;
}): Promise<AssertionRecord | null> {
  const row = await dataService.one<AssertionRow>(
    `UPDATE projection.attribute_assertion
        SET retracted_at = COALESCE(retracted_at, now())
      WHERE tenant_id = $1::uuid AND assertion_id = $2::uuid
    RETURNING ${ASSERTION_COLUMNS}`,
    [input.tenant_id, input.assertion_id],
  );
  return row ? rowToAssertion(row) : null;
}
