import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  LeadScoreRef,
  LeadScoreSubscores,
} from '@projexlight/contracts';
import {
  getProximityBackend,
  getExpertiseBackend,
  getIntentBackend,
  getStormImpactBackend,
  type ProximityInput,
  type ExpertiseInput,
  type IntentInput,
  type StormImpactInput,
} from './featureBackends';
import {
  DEFAULT_FEATURE_WEIGHTS,
  getActiveModel,
  listFeatureWeights,
} from './modelService';

/**
 * Lead scoring engine (P7 FR-LSC-1..3 / AC-3).
 *
 * scoreContact computes a 0–100 composite from the four subscores
 * (proximity, expertise, intent, storm_impact), weighted by the
 * active model's feature_weight rows. Components persist in
 * lead_scoring.score.components so the surface can explain WHY a
 * lead scored what it did.
 *
 * nextBestAction maps the dominant subscore to a recommended action
 * — a deterministic v1 (production swaps in a sdk-recommendation
 * call via setNextBestActionResolver()).
 */

const LEAD_SCORING_AUDIT_POOL = process.env.LEAD_SCORING_AUDIT_POOL || 'admin-default';

export interface ScoreContactInput {
  tenant_id: string;
  vertical: string;
  contact_id: string;
  trace_id: string;
  proximity?: ProximityInput;
  expertise?: ExpertiseInput;
  intent?: IntentInput;
  storm_impact?: StormImpactInput;
}

export interface ScoreContactResult {
  score: LeadScoreRef;
  components: Required<LeadScoreSubscores>;
  weights: Record<string, number>;
  model_id: string;
}

interface ScoreRow {
  score_id: string;
  model_id: string;
  contact_id: string;
  score: string;
  components: LeadScoreSubscores;
  computed_at: Date;
  trace_id: string;
}

function rowToScore(r: ScoreRow): LeadScoreRef {
  return {
    score_id: r.score_id,
    model_id: r.model_id,
    contact_id: r.contact_id,
    score: Number(r.score),
    components: r.components ?? {},
    computed_at: r.computed_at.toISOString(),
    trace_id: r.trace_id,
  };
}

async function resolveWeights(model_id: string): Promise<Record<string, number>> {
  const weights = await listFeatureWeights(model_id);
  if (weights.length === 0) return DEFAULT_FEATURE_WEIGHTS;
  const out: Record<string, number> = {};
  for (const w of weights) out[w.feature] = w.weight;
  // Ensure every required feature has a weight; fall back to default.
  for (const f of Object.keys(DEFAULT_FEATURE_WEIGHTS)) {
    if (out[f] == null) out[f] = DEFAULT_FEATURE_WEIGHTS[f];
  }
  return out;
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((acc, w) => acc + w, 0);
  if (total === 0) return weights;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) out[k] = v / total;
  return out;
}

/**
 * Score a contact. Resolves the active model for (tenant, vertical),
 * loads feature weights, runs the four backend subscorers, computes a
 * weighted-sum composite scaled to 0–100, persists the row, and
 * audits the decision.
 */
export async function scoreContact(input: ScoreContactInput): Promise<ScoreContactResult> {
  const model = await getActiveModel(input.tenant_id, input.vertical);
  if (!model) {
    throw new Error(
      `[sdk-lead-scoring] no active model for tenant ${input.tenant_id} vertical ${input.vertical}`,
    );
  }
  const weights = normalizeWeights(await resolveWeights(model.model_id));

  const [proximity, expertise, intent, storm_impact] = await Promise.all([
    getProximityBackend().score(input.proximity ?? {}),
    getExpertiseBackend().score(input.expertise ?? {}),
    getIntentBackend().score(input.intent ?? {}),
    getStormImpactBackend().score(input.storm_impact ?? {}),
  ]);

  const components: Required<LeadScoreSubscores> = {
    proximity,
    expertise,
    intent,
    storm_impact,
  };

  const composite =
    proximity * (weights.proximity ?? 0) +
    expertise * (weights.expertise ?? 0) +
    intent * (weights.intent ?? 0) +
    storm_impact * (weights.storm_impact ?? 0);
  const score100 = Number((composite * 100).toFixed(4));

  const scoreId = randomUUID();
  const row = await dataService.one<ScoreRow>(
    `INSERT INTO lead_scoring.score
       (score_id, model_id, contact_id, score, components, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING score_id, model_id, contact_id, score::text, components,
               computed_at, trace_id`,
    [
      scoreId,
      model.model_id,
      input.contact_id,
      score100,
      JSON.stringify(components),
      input.trace_id,
    ],
  );
  if (!row) throw new Error('[sdk-lead-scoring] score insert failed');

  try {
    await appendAuditEntry({
      pool_index: LEAD_SCORING_AUDIT_POOL,
      event_type: 'lead-scoring.scored.v1',
      actor_kind: 'service',
      actor_id: 'sdk-lead-scoring',
      tenant_id: input.tenant_id,
      subject_kind: 'lead_scoring.score',
      subject_id: scoreId,
      retention_class: 'operational',
      payload: {
        score_id: scoreId,
        model_id: model.model_id,
        contact_id: input.contact_id,
        score: score100,
        components,
        weights,
        trace_id: input.trace_id,
      },
    });
  } catch (err) {
    console.warn('[sdk-lead-scoring] audit failed (non-fatal):', (err as Error).message);
  }

  return {
    score: rowToScore(row),
    components,
    weights,
    model_id: model.model_id,
  };
}

/* ============================================================
 * Next-best-action (FR-LSC-3)
 * ============================================================ */

export type RecommendedAction =
  | 'schedule_visit'
  | 'send_offer'
  | 'reach_out'
  | 'storm_response'
  | 'nurture';

export interface NextBestActionResult {
  action: RecommendedAction;
  reason: string;
  /** Subscore that drove the recommendation. */
  driver: keyof LeadScoreSubscores;
  driver_score: number;
}

/**
 * Default next-best-action resolver: pick the highest subscore, map
 * to an action, return reason for explainability. Production swaps
 * via setNextBestActionResolver() to call sdk-recommendation.
 */
let _nextBestActionResolver: (input: ScoreContactResult) => Promise<NextBestActionResult> =
  defaultResolver;

export function setNextBestActionResolver(
  resolver: (input: ScoreContactResult) => Promise<NextBestActionResult>,
): void {
  _nextBestActionResolver = resolver;
}

export function _resetNextBestActionResolver(): void {
  _nextBestActionResolver = defaultResolver;
}

async function defaultResolver(input: ScoreContactResult): Promise<NextBestActionResult> {
  const entries = Object.entries(input.components) as Array<[keyof LeadScoreSubscores, number]>;
  entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const [driver, driverScore] = entries[0];

  // Storm impact dominates everything when >= 0.5 — that's a hot lead
  // regardless of distance because the property needs immediate work.
  if ((input.components.storm_impact ?? 0) >= 0.5) {
    return {
      action: 'storm_response',
      reason: 'storm event overlapping address; prioritize site visit',
      driver: 'storm_impact',
      driver_score: input.components.storm_impact ?? 0,
    };
  }

  // No signal in any factor → keep in nurture rather than burning an
  // outreach budget on a cold contact.
  if ((driverScore ?? 0) <= 0) {
    return {
      action: 'nurture',
      reason: 'all subscores zero — keep in nurture queue',
      driver,
      driver_score: driverScore ?? 0,
    };
  }

  switch (driver) {
    case 'proximity':
      return {
        action: 'schedule_visit',
        reason: 'high proximity score — in-territory and reachable',
        driver,
        driver_score: driverScore,
      };
    case 'expertise':
      return {
        action: 'send_offer',
        reason: 'persona kinds align with vertical specialty',
        driver,
        driver_score: driverScore,
      };
    case 'intent':
      return {
        action: 'reach_out',
        reason: 'recent engagement signals warrant a follow-up',
        driver,
        driver_score: driverScore,
      };
    default:
      return {
        action: 'nurture',
        reason: 'no strong subscore — keep in nurture queue',
        driver,
        driver_score: driverScore,
      };
  }
}

export async function nextBestAction(input: ScoreContactResult): Promise<NextBestActionResult> {
  return _nextBestActionResolver(input);
}
