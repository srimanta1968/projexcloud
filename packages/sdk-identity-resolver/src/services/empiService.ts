import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { decide, submitRequest } from '@projexlight/sdk-approval';
import type { Decision } from '@projexlight/sdk-approval';
import {
  DEFAULT_WEIGHTS,
  scoreMatch,
  type MatchableIdentity,
  type MatchWeights,
} from './fieldMatch';

/**
 * P10/E6 — Healthcare EMPI / probabilistic MDM service. Architecture v3.2
 * §11A.10. Probabilistic matching produces POSSIBLY_SAME candidate links
 * (never forced merges); high-risk matches queue for sdk-approval-governed
 * steward review; merges/unmerges are reversible compensating events; match
 * quality is calibrated (ECE) and monitored.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';
/**
 * Confidence at/above which a pair is auto-linked as a candidate.
 *
 * Exported so trait resolution raises candidates at the SAME bar this module
 * uses. A second copy of the number in the caller is a threshold that drifts
 * silently, and the direction it drifts decides whether a duplicate reaches a
 * steward or is never mentioned again.
 */
export const CANDIDATE_MIN = parseFloat(process.env.EMPI_CANDIDATE_MIN || '0.5');
/** Confidence at/above which a match is surfaced by probabilisticMatch. */
const DEFAULT_THRESHOLD = parseFloat(process.env.EMPI_MATCH_THRESHOLD || '0.7');
/** ECE above which a calibration-drift alert fires. */
const ECE_ALERT = parseFloat(process.env.EMPI_ECE_ALERT || '0.1');

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface CandidateLink {
  link_id: string;
  /** Owning tenant. NULL only for pre-tenant-scoping rows, which tenants cannot read. */
  tenant_id: string | null;
  person_id_a: string;
  person_id_b: string;
  confidence: number;
  match_type: 'POSSIBLY_SAME';
  provenance: Record<string, unknown>;
  status: 'open' | 'merged' | 'rejected' | 'superseded';
  steward_request_id: string | null;
  created_at: Date;
  updated_at: Date;
  /** When adjudication settled this link. NULL while open. */
  decided_at: Date | null;
}

export interface MergeEvent {
  merge_id: string;
  /** Deciding tenant (attribution). The merge itself acts on the global L1 person. */
  tenant_id: string | null;
  link_id: string | null;
  surviving_person_id: string;
  merged_person_id: string;
  kind: 'merge' | 'unmerge';
  reverses_merge_id: string | null;
  decided_by: string | null;
  reason: string | null;
  created_at: Date;
}

export interface ProbabilisticMatch {
  person_id: string;
  score: number;
  provenance: Record<string, number>;
}

/**
 * Raised when a link/merge id does not resolve. Typed so the HTTP layer can
 * answer 404 instead of 500: an absent row is the caller naming something that
 * does not exist, not the server failing, and reporting it as 500 sends an
 * integrator hunting a server fault that was never there — and makes it
 * indistinguishable from a genuine outage in their retry logic and alerting.
 */
export class CandidateLinkNotFoundError extends Error {
  readonly code = 'CandidateLinkNotFound';
  constructor(link_id: string) {
    super(`empi: candidate link ${link_id} not found`);
    this.name = 'CandidateLinkNotFoundError';
  }
}

export class MergeNotFoundError extends Error {
  readonly code = 'MergeNotFound';
  constructor(merge_id: string) {
    // Deliberately the same message whether the id is unknown or names an
    // 'unmerge' row: "reverse this reversal" is not a distinct API affordance.
    super(`empi: merge ${merge_id} not found`);
    this.name = 'MergeNotFoundError';
  }
}

const LINK_COLS = `link_id, tenant_id, person_id_a, person_id_b, confidence, match_type,
  provenance, status, steward_request_id, created_at, updated_at, decided_at`;

/**
 * Probabilistic matching over a candidate set. Returns POSSIBLY_SAME matches at
 * or above the threshold, sorted by confidence. Pure read — the deterministic
 * resolver path is unchanged; thresholds + weights are configurable.
 */
export function probabilisticMatch(
  subject: MatchableIdentity,
  candidates: MatchableIdentity[],
  options?: { threshold?: number; weights?: MatchWeights },
): ProbabilisticMatch[] {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const weights = options?.weights ?? DEFAULT_WEIGHTS;
  const out: ProbabilisticMatch[] = [];
  for (const cand of candidates) {
    if (!cand.person_id || cand.person_id === subject.person_id) continue;
    const { score, provenance } = scoreMatch(subject, cand, weights);
    if (score >= threshold) out.push({ person_id: cand.person_id, score, provenance });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Records a POSSIBLY_SAME candidate link + a calibration sample. Never merges. */
export async function createCandidateLink(
  tenant_id: string,
  person_id_a: string,
  person_id_b: string,
  confidence: number,
  provenance: Record<string, unknown>,
): Promise<CandidateLink> {
  // Tenant is FIRST and required. A link raised without one is invisible to every
  // tenant read below, so defaulting it would silently create work no steward can
  // ever see rather than failing where the mistake was made.
  if (!tenant_id) throw new Error('empi: tenant_id is required to raise a candidate link');
  const link = await dataService.one<CandidateLink>(
    `INSERT INTO empi.candidate_link (tenant_id, person_id_a, person_id_b, confidence, provenance)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING ${LINK_COLS}`,
    [tenant_id, person_id_a, person_id_b, confidence, JSON.stringify(provenance)],
  );
  if (!link) throw new Error('empi: failed to create candidate link');
  await dataService.query(
    `INSERT INTO empi.match_outcome (link_id, predicted_confidence) VALUES ($1, $2)`,
    [link.link_id, confidence],
  );
  await emitEvent({
    event_type: 'mdm.candidate_link.created.v1',
    payload: { link_id: link.link_id, person_id_a, person_id_b, confidence, provenance },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-identity-resolver.empi',
    tenant_id,
    subject_kind: 'person',
    subject_id: person_id_a,
  });
  return link;
}

/**
 * Runs probabilistic matching against `candidates` and records candidate links
 * for every match at/above CANDIDATE_MIN. Returns the created links — NEVER
 * performs a destructive merge.
 */
export async function matchAndLink(
  tenant_id: string,
  subject: MatchableIdentity,
  candidates: MatchableIdentity[],
  options?: { threshold?: number; weights?: MatchWeights },
): Promise<CandidateLink[]> {
  if (!subject.person_id) throw new Error('empi: subject.person_id is required');
  const matches = probabilisticMatch(subject, candidates, {
    threshold: options?.threshold ?? CANDIDATE_MIN,
    weights: options?.weights,
  });
  const links: CandidateLink[] = [];
  for (const m of matches) {
    links.push(await createCandidateLink(tenant_id, subject.person_id, m.person_id, m.score, m.provenance));
  }
  return links;
}

function bandRange(band: ConfidenceBand): { min: number; max: number } {
  if (band === 'high') return { min: 0.9, max: 1 };
  if (band === 'medium') return { min: 0.7, max: 0.9 };
  return { min: 0, max: 0.7 };
}

/** Queries candidate links by confidence band (or explicit min/max) + status. */
export async function queryCandidateLinksByBand(opts: {
  tenant_id: string;
  band?: ConfidenceBand;
  min?: number;
  max?: number;
  status?: CandidateLink['status'];
  limit?: number;
}): Promise<CandidateLink[]> {
  // `tenant_id = $N` and NOT `(tenant_id = $N OR tenant_id IS NULL)`. Pre-migration
  // rows cannot have their tenant inferred, so they stay invisible to tenant reads
  // instead of being shown to everyone — unattributable history fails closed.
  if (!opts.tenant_id) throw new Error('empi: tenant_id is required to list candidate links');
  const range = opts.band ? bandRange(opts.band) : { min: opts.min ?? 0, max: opts.max ?? 1 };
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.status) {
    return dataService.rows<CandidateLink>(
      `SELECT ${LINK_COLS} FROM empi.candidate_link
        WHERE tenant_id = $1 AND confidence >= $2 AND confidence <= $3 AND status = $4
        ORDER BY confidence DESC LIMIT $5`,
      [opts.tenant_id, range.min, range.max, opts.status, limit],
    );
  }
  return dataService.rows<CandidateLink>(
    `SELECT ${LINK_COLS} FROM empi.candidate_link
      WHERE tenant_id = $1 AND confidence >= $2 AND confidence <= $3
      ORDER BY confidence DESC LIMIT $4`,
    [opts.tenant_id, range.min, range.max, limit],
  );
}

/** Reads one candidate link. */
export async function getCandidateLink(
  link_id: string,
  tenant_id: string,
): Promise<CandidateLink | null> {
  return dataService.one<CandidateLink>(
    `SELECT ${LINK_COLS} FROM empi.candidate_link WHERE link_id = $1 AND tenant_id = $2`,
    [link_id, tenant_id],
  );
}

/**
 * Queues an ambiguous candidate link for steward review via sdk-approval.
 * Stores the gating request id on the link. Returns the pending step ids.
 */
export async function enqueueStewardReview(
  link_id: string,
  opts: { tenant_id: string; route_id: string; steward_persona_id: string },
): Promise<{ link: CandidateLink; pending_step_ids: string[] }> {
  const link = await getCandidateLink(link_id, opts.tenant_id);
  if (!link) throw new CandidateLinkNotFoundError(link_id);
  const submitted = await submitRequest({
    tenant_id: opts.tenant_id,
    route_id: opts.route_id,
    subject_kind: 'empi_candidate',
    subject_id: link_id,
    initiator_persona_id: opts.steward_persona_id,
    reason: `Steward review of POSSIBLY_SAME link ${link_id} (confidence ${link.confidence})`,
  });
  const updated = await dataService.one<CandidateLink>(
    `UPDATE empi.candidate_link SET steward_request_id = $2, updated_at = now()
      WHERE link_id = $1 RETURNING ${LINK_COLS}`,
    [link_id, submitted.request.request_id],
  );
  return { link: updated ?? link, pending_step_ids: submitted.pending_steps.map((s) => s.step_id) };
}

/**
 * Steward adjudication via sdk-approval delegation. On approve, merges the two
 * persons (reversible) and labels the match a true positive; on reject, marks
 * the link rejected and labels a true negative. Records the decision.
 */
export async function adjudicateCandidate(
  link_id: string,
  tenant_id: string,
  step_id: string,
  steward_persona_id: string,
  decision: Decision,
  reason?: string,
): Promise<{ link: CandidateLink; merge: MergeEvent | null }> {
  const link = await getCandidateLink(link_id, tenant_id);
  if (!link) throw new CandidateLinkNotFoundError(link_id);
  const result = await decide({ step_id, decision, reason, acting_persona_id: steward_persona_id });

  let merge: MergeEvent | null = null;
  if (result.request.status === 'approved') {
    await labelOutcome(link_id, true);
    merge = await mergeRecords({
      tenant_id,
      surviving_person_id: link.person_id_a,
      merged_person_id: link.person_id_b,
      link_id,
      decided_by: steward_persona_id,
      reason,
    });
  } else if (result.request.status === 'rejected') {
    await labelOutcome(link_id, false);
    await dataService.query(
      `UPDATE empi.candidate_link
          SET status = 'rejected', updated_at = now(), decided_at = now()
        WHERE link_id = $1`,
      [link_id],
    );
  }
  await emitEvent({
    event_type: 'mdm.steward.decided.v1',
    payload: { link_id, decision, request_status: result.request.status, reason: reason ?? null },
    pool_index: POOL_INDEX,
    actor_kind: 'human',
    actor_id: steward_persona_id,
    tenant_id,
    subject_kind: 'person',
    subject_id: link.person_id_a,
  });
  const refreshed = await getCandidateLink(link_id, tenant_id);
  return { link: refreshed ?? link, merge };
}

async function labelOutcome(link_id: string, actual: boolean): Promise<void> {
  await dataService.query(
    `UPDATE empi.match_outcome SET actual_match = $2 WHERE link_id = $1`,
    [link_id, actual],
  );
}

/** Merges two persons as a reversible, event-sourced event (no destructive delete). */
export async function mergeRecords(input: {
  /** Deciding tenant — attribution. The merge acts on the global L1 person. */
  tenant_id: string;
  surviving_person_id: string;
  merged_person_id: string;
  link_id?: string;
  decided_by?: string;
  reason?: string;
}): Promise<MergeEvent> {
  const merge = await dataService.one<MergeEvent>(
    `INSERT INTO empi.merge_event (tenant_id, link_id, surviving_person_id, merged_person_id, kind, decided_by, reason)
     VALUES ($1, $2, $3, $4, 'merge', $5, $6)
     RETURNING merge_id, tenant_id, link_id, surviving_person_id, merged_person_id, kind, reverses_merge_id, decided_by, reason, created_at`,
    [input.tenant_id, input.link_id ?? null, input.surviving_person_id, input.merged_person_id, input.decided_by ?? null, input.reason ?? null],
  );
  if (!merge) throw new Error('empi: merge failed');
  if (input.link_id) {
    // COALESCE so a repeat merge against an already-settled link cannot overwrite
    // the original decision time. Reopening is the unmerge path's job: it clears
    // decided_at, and the next merge then stamps a fresh one — which is correct,
    // because a reopened case is a new review with its own latency.
    await dataService.query(
      `UPDATE empi.candidate_link
          SET status = 'merged', updated_at = now(), decided_at = COALESCE(decided_at, now())
        WHERE link_id = $1`,
      [input.link_id],
    );
  }
  await emitEvent({
    event_type: 'mdm.merge.performed.v1',
    payload: {
      merge_id: merge.merge_id,
      surviving_person_id: merge.surviving_person_id,
      merged_person_id: merge.merged_person_id,
      link_id: merge.link_id,
    },
    pool_index: POOL_INDEX,
    actor_kind: input.decided_by ? 'human' : 'service',
    actor_id: input.decided_by ?? 'sdk-identity-resolver.empi',
    tenant_id: input.tenant_id,
    subject_kind: 'person',
    subject_id: merge.surviving_person_id,
  });
  return merge;
}

/** Unmerges a prior merge via a compensating event; full history is preserved. */
export async function unmergeRecords(
  merge_id: string,
  tenant_id: string,
  input: { decided_by?: string; reason?: string } = {},
): Promise<MergeEvent> {
  const original = await dataService.one<MergeEvent>(
    `SELECT merge_id, tenant_id, link_id, surviving_person_id, merged_person_id, kind, reverses_merge_id, decided_by, reason, created_at
       FROM empi.merge_event WHERE merge_id = $1 AND kind = 'merge' AND tenant_id = $2`,
    [merge_id, tenant_id],
  );
  if (!original) throw new MergeNotFoundError(merge_id);
  const compensation = await dataService.one<MergeEvent>(
    `INSERT INTO empi.merge_event
       (tenant_id, link_id, surviving_person_id, merged_person_id, kind, reverses_merge_id, decided_by, reason)
     VALUES ($1, $2, $3, $4, 'unmerge', $5, $6, $7)
     RETURNING merge_id, tenant_id, link_id, surviving_person_id, merged_person_id, kind, reverses_merge_id, decided_by, reason, created_at`,
    [
      tenant_id,
      original.link_id,
      original.surviving_person_id,
      original.merged_person_id,
      merge_id,
      input.decided_by ?? null,
      input.reason ?? null,
    ],
  );
  if (!compensation) throw new Error('empi: unmerge failed');
  if (original.link_id) {
    // Reopening clears decided_at: the case is back in the queue, and leaving the
    // old stamp would both count it as settled in the latency aggregate and hide
    // the second review entirely.
    await dataService.query(
      `UPDATE empi.candidate_link
          SET status = 'open', updated_at = now(), decided_at = NULL
        WHERE link_id = $1`,
      [original.link_id],
    );
  }
  await emitEvent({
    event_type: 'mdm.merge.reversed.v1',
    payload: {
      merge_id: compensation.merge_id,
      reverses_merge_id: merge_id,
      surviving_person_id: original.surviving_person_id,
      merged_person_id: original.merged_person_id,
    },
    pool_index: POOL_INDEX,
    actor_kind: input.decided_by ? 'human' : 'service',
    actor_id: input.decided_by ?? 'sdk-identity-resolver.empi',
    tenant_id,
    subject_kind: 'person',
    subject_id: original.surviving_person_id,
  });
  return compensation;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  avg_confidence: number;
  accuracy: number;
}

export interface CalibrationResult {
  ece: number;
  sample_count: number;
  bins: CalibrationBin[];
}

/**
 * Computes Expected Calibration Error over labeled match outcomes: bins
 * predicted confidence into `binCount` buckets and sums |avg_confidence -
 * accuracy| weighted by bucket size.
 */
export async function computeCalibration(tenant_id: string, binCount = 10): Promise<CalibrationResult> {
  // match_outcome has no tenant of its own — it hangs off the link, so the join is
  // what scopes it. An INNER join also drops samples whose link was deleted, which
  // is correct: an outcome we cannot attribute to a tenant is not that tenant's.
  const rows = await dataService.rows<{ predicted_confidence: number; actual_match: boolean }>(
    `SELECT mo.predicted_confidence, mo.actual_match
       FROM empi.match_outcome mo
       JOIN empi.candidate_link cl ON cl.link_id = mo.link_id
      WHERE mo.actual_match IS NOT NULL AND cl.tenant_id = $1`,
    [tenant_id],
  );
  const total = rows.length;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const inBin = rows.filter((r) => {
      const c = Number(r.predicted_confidence);
      return i === binCount - 1 ? c >= lower && c <= upper : c >= lower && c < upper;
    });
    const count = inBin.length;
    const avg_confidence = count ? inBin.reduce((s, r) => s + Number(r.predicted_confidence), 0) / count : 0;
    const accuracy = count ? inBin.filter((r) => r.actual_match).length / count : 0;
    bins.push({ lower, upper, count, avg_confidence, accuracy });
  }
  const ece = total === 0
    ? 0
    : bins.reduce((s, b) => s + (b.count / total) * Math.abs(b.avg_confidence - b.accuracy), 0);
  return { ece: Math.round(ece * 10000) / 10000, sample_count: total, bins };
}

/**
 * Adjudicated outcomes for one confidence band.
 *
 * `precision` is the share of adjudicated links in the band the steward
 * confirmed. It is deliberately NULL — not 0 — when nothing in the band has been
 * adjudicated yet: 0 reads as "the matcher is wrong every time", which is the
 * opposite conclusion from "we have not checked any of these", and a precision
 * dial pinned at zero is exactly the kind of number that gets escalated.
 */
export interface BandOutcome {
  band: ConfidenceBand;
  /** Links in this band whose outcome a steward has labelled. */
  labeled: number;
  /** Labelled as a genuine match. */
  true_positive: number;
  /** Labelled as NOT a match. */
  false_positive: number;
  /** true_positive / labeled, or null when labeled = 0. */
  precision: number | null;
}

/**
 * How long stewards take to settle a case, over a bounded recent window.
 *
 * Measured created_at -> decided_at, so it is the latency of DECIDED cases only.
 * That is the deliberate choice: the median AGE OF OPEN CASES is trivially
 * available and actively misleading — it rises while a queue is ignored (reading
 * as improving service) and falls when a steward clears the oldest backlog, which
 * is the moment they are working hardest.
 *
 * Null medians mean nothing settled in the window. Callers should render that as
 * "not measured" rather than as zero.
 */
export interface ReviewLatency {
  window_days: number;
  settled_count: number;
  median_minutes: number | null;
  p90_minutes: number | null;
}

export interface EmpiMetrics {
  unresolved_candidate_links: number;
  merge_reversals: number;
  total_merges: number;
  calibration_ece: number;
  confidence_distribution: { band: ConfidenceBand; count: number }[];
  drift_alert: boolean;
  /** Per-band adjudicated outcomes — always all three bands, in high→low order. */
  band_outcomes: BandOutcome[];
  /** Convenience alias for the 'high' band's precision. Null when unlabelled. */
  high_risk_precision: number | null;
  review_latency: ReviewLatency;
}

/** Window for the review-latency aggregate. */
const REVIEW_WINDOW_DAYS = parseInt(process.env.EMPI_REVIEW_WINDOW_DAYS || '30', 10);

const ALL_BANDS: ConfidenceBand[] = ['high', 'medium', 'low'];

/**
 * Per-band adjudicated outcomes, from the calibration samples.
 *
 * Banded on match_outcome.predicted_confidence rather than on the link's current
 * confidence, so a band reports the outcomes of the predictions it actually made.
 * Bands with no rows are still returned, at zero — an absent band would be
 * indistinguishable from a band the query forgot.
 */
export async function getBandOutcomes(tenant_id: string): Promise<BandOutcome[]> {
  const rows = await dataService.rows<{
    band: ConfidenceBand; labeled: string; true_positive: string; false_positive: string;
  }>(
    `SELECT CASE WHEN mo.predicted_confidence >= 0.9 THEN 'high'
                 WHEN mo.predicted_confidence >= 0.7 THEN 'medium'
                 ELSE 'low' END AS band,
            count(*) FILTER (WHERE mo.actual_match IS NOT NULL)::text AS labeled,
            count(*) FILTER (WHERE mo.actual_match IS TRUE)::text     AS true_positive,
            count(*) FILTER (WHERE mo.actual_match IS FALSE)::text    AS false_positive
       FROM empi.match_outcome mo
       JOIN empi.candidate_link cl ON cl.link_id = mo.link_id
      WHERE cl.tenant_id = $1
      GROUP BY 1`,
    [tenant_id],
  );
  const byBand = new Map(rows.map((r) => [r.band, r]));
  return ALL_BANDS.map((band) => {
    const r = byBand.get(band);
    const labeled = Number(r?.labeled ?? 0);
    const true_positive = Number(r?.true_positive ?? 0);
    return {
      band,
      labeled,
      true_positive,
      false_positive: Number(r?.false_positive ?? 0),
      precision: labeled === 0 ? null : Math.round((true_positive / labeled) * 10000) / 10000,
    };
  });
}

/** Median + p90 minutes from candidate-link creation to adjudication. */
export async function getReviewLatency(
  tenant_id: string,
  windowDays = REVIEW_WINDOW_DAYS,
): Promise<ReviewLatency> {
  const row = await dataService.one<{
    settled_count: string; median_minutes: string | null; p90_minutes: string | null;
  }>(
    `SELECT count(*)::text AS settled_count,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at)) / 60.0
            ) AS median_minutes,
            percentile_cont(0.9) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at)) / 60.0
            ) AS p90_minutes
       FROM empi.candidate_link
      WHERE tenant_id = $1
        AND decided_at IS NOT NULL
        AND decided_at >= now() - make_interval(days => $2)`,
    [tenant_id, windowDays],
  );
  const round1 = (v: string | null): number | null =>
    v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
  return {
    window_days: windowDays,
    settled_count: Number(row?.settled_count ?? 0),
    median_minutes: round1(row?.median_minutes ?? null),
    p90_minutes: round1(row?.p90_minutes ?? null),
  };
}

/**
 * Surfaces EMPI observability: unresolved identities, merge reversals, match
 * confidence distribution and calibration. Emits a drift alert when ECE breaches
 * the threshold.
 */
export async function getEmpiMetrics(tenant_id: string): Promise<EmpiMetrics> {
  if (!tenant_id) throw new Error('empi: tenant_id is required to read metrics');
  const unresolved = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM empi.candidate_link WHERE tenant_id = $1 AND status = 'open'`,
    [tenant_id],
  );
  const reversals = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM empi.merge_event WHERE tenant_id = $1 AND kind = 'unmerge'`,
    [tenant_id],
  );
  const merges = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM empi.merge_event WHERE tenant_id = $1 AND kind = 'merge'`,
    [tenant_id],
  );
  const dist = await dataService.rows<{ band: ConfidenceBand; count: string }>(
    `SELECT CASE WHEN confidence >= 0.9 THEN 'high'
                 WHEN confidence >= 0.7 THEN 'medium'
                 ELSE 'low' END AS band,
            count(*)::text AS count
       FROM empi.candidate_link WHERE tenant_id = $1 GROUP BY 1`,
    [tenant_id],
  );
  const band_outcomes = await getBandOutcomes(tenant_id);
  const review_latency = await getReviewLatency(tenant_id);
  const calibration = await computeCalibration(tenant_id);
  const drift_alert = calibration.ece > ECE_ALERT;
  if (drift_alert) {
    await emitEvent({
      event_type: 'mdm.calibration.drift.v1',
      payload: { ece: calibration.ece, threshold: ECE_ALERT, sample_count: calibration.sample_count },
      pool_index: POOL_INDEX,
      actor_kind: 'service',
      actor_id: 'sdk-identity-resolver.empi',
      tenant_id,
      subject_kind: 'empi',
      subject_id: 'calibration',
    });
  }
  return {
    unresolved_candidate_links: Number(unresolved?.n ?? 0),
    merge_reversals: Number(reversals?.n ?? 0),
    total_merges: Number(merges?.n ?? 0),
    calibration_ece: calibration.ece,
    confidence_distribution: dist.map((d) => ({ band: d.band, count: Number(d.count) })),
    drift_alert,
    band_outcomes,
    high_risk_precision: band_outcomes.find((b) => b.band === 'high')?.precision ?? null,
    review_latency,
  };
}
