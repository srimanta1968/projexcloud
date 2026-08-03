/**
 * B2B firmographic and intent feature families (P16 · EP-385).
 *
 * A REGISTRY ADDITION, not an API change. The shipped geo/field-service features
 * (proximity, expertise, intent, storm_impact) keep their own code path and their own
 * weights untouched; these are additional named features that flow through the SAME
 * POST /api/lead-scoring/models, PUT /weights/:feature and POST /score endpoints, because
 * those already address features by name rather than by a fixed list.
 *
 * Every feature is a pure function from evidence to 0..1 PLUS an explanation. The
 * explanation is not decoration: a lead score that cannot say why it is 38 is unarguable,
 * and the first question a salesperson asks about a low score is which input caused it.
 * Returning the attribution alongside the number is what makes the model tunable by the
 * people who use it rather than only by whoever wrote the weights.
 *
 * Every scorer also returns `evidence: false` when the caller supplied nothing for it. A
 * missing signal is NOT a zero — zero means "we looked and it was bad", absent means "we
 * never knew". Conflating them silently penalises every lead whose enrichment has not run
 * yet, which is most of them on day one.
 */

export type B2BFeatureFamily = 'firmographic' | 'intent' | 'quality';

export interface FeatureOutcome {
  /** 0..1. Meaningless unless `evidence` is true. */
  value: number;
  /** False when the caller supplied nothing — absent is not the same as bad. */
  evidence: boolean;
  /** Human-readable, and specific enough to act on. */
  explanation: string;
}

export interface B2BFeatureDef<TInput = unknown> {
  id: string;
  family: B2BFeatureFamily;
  description: string;
  score(input: TInput | undefined): FeatureOutcome;
}

const absent = (what: string): FeatureOutcome => ({
  value: 0,
  evidence: false,
  explanation: `no ${what} supplied — treated as unknown, not as a negative signal`,
});

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Firmographic
// ---------------------------------------------------------------------------

export interface CompanySizeInput { employee_count?: number; ideal_min?: number; ideal_max?: number }

/**
 * Company size against the tenant's ideal band.
 *
 * Deliberately NOT "bigger is better": most B2B products have a band they fit, and a
 * 50,000-person enterprise is often a worse lead than a 200-person one because the sales
 * motion does not match. Scoring linearly by headcount would systematically mis-rank.
 */
export const companySizeFeature: B2BFeatureDef<CompanySizeInput> = {
  id: 'b2b_company_size',
  family: 'firmographic',
  description: 'Employee count relative to the tenant ideal band (in-band scores highest).',
  score(input) {
    if (!input || typeof input.employee_count !== 'number') return absent('employee_count');
    const n = input.employee_count;
    const min = input.ideal_min ?? 10;
    const max = input.ideal_max ?? 1000;
    if (n >= min && n <= max) {
      return { value: 1, evidence: true, explanation: `${n} employees is inside the ideal band ${min}-${max}` };
    }
    // Decay by how far outside the band it sits, relative to the band's own width, so the
    // penalty scales with the tenant's definition rather than an arbitrary constant.
    const width = Math.max(max - min, 1);
    const distance = n < min ? min - n : n - max;
    const value = clamp01(1 - distance / width);
    return {
      value,
      evidence: true,
      explanation: `${n} employees is ${n < min ? 'below' : 'above'} the ideal band ${min}-${max} by ${distance}`,
    };
  },
};

export interface SegmentInput { segment?: string; target_segments?: string[] }

export const segmentFeature: B2BFeatureDef<SegmentInput> = {
  id: 'b2b_segment',
  family: 'firmographic',
  description: 'Whether the account segment is one the tenant targets.',
  score(input) {
    if (!input?.segment) return absent('segment');
    const targets = (input.target_segments ?? []).map((s) => s.toLowerCase());
    if (targets.length === 0) {
      // No target list is not a match failure — the tenant simply has not said.
      return { value: 0.5, evidence: true, explanation: `segment '${input.segment}' recorded but the tenant declared no target segments` };
    }
    const hit = targets.includes(input.segment.toLowerCase());
    return {
      value: hit ? 1 : 0,
      evidence: true,
      explanation: hit
        ? `segment '${input.segment}' is a declared target`
        : `segment '${input.segment}' is not among the targets [${targets.join(', ')}]`,
    };
  },
};

export interface DomainAgeInput { domain_age_days?: number }

/**
 * Domain age. A very young domain is the strongest cheap signal of a throwaway or
 * fraudulent lead, so the curve is steep early and flat after ~2 years, where further age
 * stops carrying information.
 */
export const domainAgeFeature: B2BFeatureDef<DomainAgeInput> = {
  id: 'b2b_domain_age',
  family: 'firmographic',
  description: 'Registered age of the email/website domain; steep below two years.',
  score(input) {
    if (!input || typeof input.domain_age_days !== 'number') return absent('domain_age_days');
    const days = Math.max(input.domain_age_days, 0);
    const value = clamp01(days / 730);
    return {
      value,
      evidence: true,
      explanation: days < 90
        ? `domain is only ${days} days old — a common signal of a throwaway or fraudulent lead`
        : `domain is ${days} days old (saturates at 730)`,
    };
  },
};

export interface DomainAuthorityInput { authority_score?: number; max_scale?: number }

export const domainAuthorityFeature: B2BFeatureDef<DomainAuthorityInput> = {
  id: 'b2b_domain_authority',
  family: 'firmographic',
  description: 'Third-party domain authority, normalised to its own scale.',
  score(input) {
    if (!input || typeof input.authority_score !== 'number') return absent('authority_score');
    // Normalised against the provider's own scale, because vendors use 0-100 and 0-10
    // interchangeably and a raw number would silently mean different things per tenant.
    const scale = input.max_scale && input.max_scale > 0 ? input.max_scale : 100;
    const value = clamp01(input.authority_score / scale);
    return { value, evidence: true, explanation: `domain authority ${input.authority_score} of ${scale}` };
  },
};

export interface TechnologySignalsInput { detected?: string[]; desired?: string[] }

export const technologySignalsFeature: B2BFeatureDef<TechnologySignalsInput> = {
  id: 'b2b_technology_signals',
  family: 'firmographic',
  description: 'Overlap between detected technologies and the ones the tenant sells alongside.',
  score(input) {
    if (!input?.detected?.length) return absent('detected technologies');
    const desired = (input.desired ?? []).map((s) => s.toLowerCase());
    if (desired.length === 0) {
      return { value: 0.5, evidence: true, explanation: `${input.detected.length} technologies detected but no desired list declared` };
    }
    const detected = input.detected.map((s) => s.toLowerCase());
    const matched = desired.filter((d) => detected.includes(d));
    return {
      value: clamp01(matched.length / desired.length),
      evidence: true,
      explanation: matched.length
        ? `matched ${matched.length}/${desired.length} desired technologies: ${matched.join(', ')}`
        : `none of the desired technologies [${desired.join(', ')}] were detected`,
    };
  },
};

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export interface PageIntentInput { page_views?: number; sessions?: number; high_intent_pages?: number }

export const pageIntentFeature: B2BFeatureDef<PageIntentInput> = {
  id: 'b2b_page_intent',
  family: 'intent',
  description: 'Depth of site engagement, weighted toward high-intent pages.',
  score(input) {
    if (!input || (input.page_views == null && input.high_intent_pages == null)) {
      return absent('page engagement');
    }
    const views = input.page_views ?? 0;
    const high = input.high_intent_pages ?? 0;
    // A high-intent page counts for several ordinary ones: someone reading the integration
    // docs is a different prospect from someone who bounced through five blog posts.
    const weighted = views + high * 4;
    const value = clamp01(weighted / 20);
    return {
      value,
      evidence: true,
      explanation: `${views} page views and ${high} high-intent pages across ${input.sessions ?? 1} session(s)`,
    };
  },
};

export interface PricingIntentInput { pricing_views?: number; days_since_last_pricing_view?: number }

/**
 * Pricing-page intent. The single strongest self-reported buying signal, but it DECAYS:
 * someone who read pricing today is in-market, someone who read it four months ago is not.
 * Scoring the raw count would keep a stale lead permanently hot.
 */
export const pricingIntentFeature: B2BFeatureDef<PricingIntentInput> = {
  id: 'b2b_pricing_intent',
  family: 'intent',
  description: 'Pricing-page views, decayed by how long ago they happened.',
  score(input) {
    if (!input || typeof input.pricing_views !== 'number') return absent('pricing_views');
    const base = clamp01(input.pricing_views / 3);
    const days = input.days_since_last_pricing_view;
    if (typeof days !== 'number') {
      return { value: base, evidence: true, explanation: `${input.pricing_views} pricing view(s), recency unknown so undecayed` };
    }
    const decay = clamp01(1 - days / 30);
    return {
      value: clamp01(base * decay),
      evidence: true,
      explanation: `${input.pricing_views} pricing view(s), last ${days} day(s) ago (decays to zero at 30 days)`,
    };
  },
};

export interface ResponseRecencyInput { days_since_last_response?: number }

export const responseRecencyFeature: B2BFeatureDef<ResponseRecencyInput> = {
  id: 'b2b_response_recency',
  family: 'intent',
  description: 'How recently the lead last replied to us.',
  score(input) {
    if (!input || typeof input.days_since_last_response !== 'number') {
      return absent('days_since_last_response');
    }
    const days = Math.max(input.days_since_last_response, 0);
    const value = clamp01(1 - days / 14);
    return {
      value,
      evidence: true,
      explanation: `last replied ${days} day(s) ago (decays to zero at 14 days)`,
    };
  },
};

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface FormCompletenessInput { provided_fields?: string[]; requested_fields?: string[] }

export const formCompletenessFeature: B2BFeatureDef<FormCompletenessInput> = {
  id: 'b2b_form_completeness',
  family: 'quality',
  description: 'Proportion of requested form fields the lead actually filled in.',
  score(input) {
    if (!input?.requested_fields?.length) return absent('requested_fields');
    const provided = new Set((input.provided_fields ?? []).map((f) => f.toLowerCase()));
    const filled = input.requested_fields.filter((f) => provided.has(f.toLowerCase()));
    const missing = input.requested_fields.filter((f) => !provided.has(f.toLowerCase()));
    return {
      value: clamp01(filled.length / input.requested_fields.length),
      evidence: true,
      explanation: missing.length
        ? `filled ${filled.length}/${input.requested_fields.length} fields; missing ${missing.join(', ')}`
        : `filled all ${filled.length} requested fields`,
    };
  },
};

export interface SourceQualityInput { source?: string; source_quality_map?: Record<string, number> }

export const sourceQualityFeature: B2BFeatureDef<SourceQualityInput> = {
  id: 'b2b_source_quality',
  family: 'quality',
  description: 'Historic quality of the acquisition source, as scored by the tenant.',
  score(input) {
    if (!input?.source) return absent('source');
    const map = input.source_quality_map ?? {};
    const raw = map[input.source] ?? map[input.source.toLowerCase()];
    if (typeof raw !== 'number') {
      // An unrated source is mid, not bad: rating it 0 would bury every new channel
      // before it ever had the chance to produce the data that would rate it.
      return { value: 0.5, evidence: true, explanation: `source '${input.source}' has no recorded quality rating — scored neutral` };
    }
    return { value: clamp01(raw), evidence: true, explanation: `source '${input.source}' rated ${raw}` };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, B2BFeatureDef<never>>();

function register(def: B2BFeatureDef<never>): void {
  REGISTRY.set(def.id, def);
}

[
  companySizeFeature, segmentFeature, domainAgeFeature, domainAuthorityFeature,
  technologySignalsFeature, pageIntentFeature, pricingIntentFeature,
  responseRecencyFeature, formCompletenessFeature, sourceQualityFeature,
].forEach((d) => register(d as B2BFeatureDef<never>));

export function listB2BFeatures(): Array<{ id: string; family: B2BFeatureFamily; description: string }> {
  return [...REGISTRY.values()].map((d) => ({ id: d.id, family: d.family, description: d.description }));
}

export function getB2BFeature(id: string): B2BFeatureDef<never> | undefined {
  return REGISTRY.get(id);
}

/** Register a vertical-specific feature without forking this package. */
export function registerB2BFeature(def: B2BFeatureDef<never>): void {
  register(def);
}

/** Sensible starting weights. A tenant overrides any of them via PUT /weights/:feature. */
export const DEFAULT_B2B_WEIGHTS: Record<string, number> = {
  b2b_company_size: 0.12,
  b2b_segment: 0.12,
  b2b_domain_age: 0.06,
  b2b_domain_authority: 0.06,
  b2b_technology_signals: 0.08,
  b2b_page_intent: 0.14,
  b2b_pricing_intent: 0.18,
  b2b_response_recency: 0.12,
  b2b_form_completeness: 0.06,
  b2b_source_quality: 0.06,
};

export interface B2BSignals {
  company_size?: CompanySizeInput;
  segment?: SegmentInput;
  domain_age?: DomainAgeInput;
  domain_authority?: DomainAuthorityInput;
  technology_signals?: TechnologySignalsInput;
  page_intent?: PageIntentInput;
  pricing_intent?: PricingIntentInput;
  response_recency?: ResponseRecencyInput;
  form_completeness?: FormCompletenessInput;
  source_quality?: SourceQualityInput;
}

/** Feature id → the key its evidence arrives under, so callers pass a readable object. */
const SIGNAL_KEY: Record<string, keyof B2BSignals> = {
  b2b_company_size: 'company_size',
  b2b_segment: 'segment',
  b2b_domain_age: 'domain_age',
  b2b_domain_authority: 'domain_authority',
  b2b_technology_signals: 'technology_signals',
  b2b_page_intent: 'page_intent',
  b2b_pricing_intent: 'pricing_intent',
  b2b_response_recency: 'response_recency',
  b2b_form_completeness: 'form_completeness',
  b2b_source_quality: 'source_quality',
};

export interface FeatureAttribution {
  feature: string;
  family: B2BFeatureFamily;
  /** The feature's own 0..1 output. */
  raw: number;
  weight: number;
  /** raw * weight — how much of the composite this feature actually accounts for. */
  contribution: number;
  evidence: boolean;
  explanation: string;
}

/**
 * Evaluate every registered B2B feature for which a weight exists.
 *
 * Features WITHOUT evidence are still returned, with evidence:false and a zero
 * contribution, and their weight is reported as excluded. Dropping them silently would
 * make two leads with identical scores indistinguishable when one was fully enriched and
 * the other simply unknown — the difference a salesperson most needs to see.
 */
export function evaluateB2BFeatures(
  signals: B2BSignals | undefined,
  weights: Record<string, number>,
): { attribution: FeatureAttribution[]; subtotal: number; evidence_weight: number } {
  const attribution: FeatureAttribution[] = [];
  let subtotal = 0;
  let evidence_weight = 0;

  for (const [id, def] of REGISTRY) {
    const weight = weights[id];
    if (weight == null) continue; // not part of this model
    const key = SIGNAL_KEY[id];
    const outcome = def.score((key && signals ? signals[key] : undefined) as never);
    const contribution = outcome.evidence ? outcome.value * weight : 0;
    if (outcome.evidence) {
      subtotal += contribution;
      evidence_weight += weight;
    }
    attribution.push({
      feature: id,
      family: def.family,
      raw: Number(outcome.value.toFixed(4)),
      weight,
      contribution: Number(contribution.toFixed(4)),
      evidence: outcome.evidence,
      explanation: outcome.explanation,
    });
  }

  // Sorted by what actually moved the number, so the first entry answers "why this score".
  attribution.sort((a, b) => b.contribution - a.contribution || a.feature.localeCompare(b.feature));
  return { attribution, subtotal, evidence_weight };
}
