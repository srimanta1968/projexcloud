import { describe, it, expect } from 'vitest';
import {
  listB2BFeatures,
  getB2BFeature,
  registerB2BFeature,
  evaluateB2BFeatures,
  DEFAULT_B2B_WEIGHTS,
  companySizeFeature,
  pricingIntentFeature,
  sourceQualityFeature,
  segmentFeature,
  formCompletenessFeature,
  domainAgeFeature,
} from '../src/services/b2bFeatures';

/**
 * The feature registry is pure — evidence in, 0..1 plus an explanation out — so it is
 * unit-tested. What the api_definition cannot reach is the absent-vs-zero distinction and
 * the attribution ordering, which is what these assert.
 */

describe('the B2B families are registered (AC1)', () => {
  it('registers all nine described features across three families', () => {
    const all = listB2BFeatures();
    const ids = all.map((f) => f.id);
    for (const id of [
      'b2b_company_size', 'b2b_segment', 'b2b_domain_age', 'b2b_domain_authority',
      'b2b_technology_signals', 'b2b_page_intent', 'b2b_pricing_intent',
      'b2b_response_recency', 'b2b_form_completeness', 'b2b_source_quality',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(all.map((f) => f.family))).toEqual(
      new Set(['firmographic', 'intent', 'quality']),
    );
  });

  it('every registered feature has a default weight, and they sum to 1', () => {
    for (const f of listB2BFeatures()) {
      expect(DEFAULT_B2B_WEIGHTS[f.id]).toBeGreaterThan(0);
    }
    const total = Object.values(DEFAULT_B2B_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('a vertical can register its own feature without forking the package', () => {
    registerB2BFeature({
      id: 'custom_test_feature', family: 'quality', description: 'test only',
      score: () => ({ value: 1, evidence: true, explanation: 'always' }),
    } as never);
    expect(getB2BFeature('custom_test_feature')).toBeDefined();
  });
});

describe('a missing signal is not a zero', () => {
  it('reports evidence:false rather than scoring the lead down', () => {
    const r = companySizeFeature.score(undefined);
    expect(r.evidence).toBe(false);
    expect(r.explanation).toMatch(/not as a negative signal/);
  });

  it('an unevidenced feature contributes nothing and does not drag the score', () => {
    const withNothing = evaluateB2BFeatures(undefined, { b2b_company_size: 0.5 });
    expect(withNothing.subtotal).toBe(0);
    expect(withNothing.evidence_weight).toBe(0);
    // Still REPORTED, so a fully-enriched lead and an unknown one are distinguishable
    // even when their scores match.
    expect(withNothing.attribution[0].evidence).toBe(false);
  });

  it('an unrated source scores neutral, not zero', () => {
    // Rating a new channel 0 would bury it before it ever produced the data to rate it.
    const r = sourceQualityFeature.score({ source: 'brand-new-channel' });
    expect(r.value).toBe(0.5);
    expect(r.explanation).toMatch(/no recorded quality rating/);
  });

  it('a recorded segment with no declared targets is neutral, not a miss', () => {
    const r = segmentFeature.score({ segment: 'healthcare' });
    expect(r.value).toBe(0.5);
    expect(r.explanation).toMatch(/declared no target segments/);
  });
});

describe('feature semantics', () => {
  it('company size peaks INSIDE the ideal band, not at the largest value', () => {
    const inBand = companySizeFeature.score({ employee_count: 200, ideal_min: 10, ideal_max: 1000 });
    const huge = companySizeFeature.score({ employee_count: 50_000, ideal_min: 10, ideal_max: 1000 });
    expect(inBand.value).toBe(1);
    // Bigger is NOT better: a 50k enterprise is often a worse fit than a 200-person firm.
    expect(huge.value).toBeLessThan(inBand.value);
    expect(huge.explanation).toMatch(/above the ideal band/);
  });

  it('pricing intent decays with time since the visit', () => {
    const today = pricingIntentFeature.score({ pricing_views: 3, days_since_last_pricing_view: 0 });
    const lastWeek = pricingIntentFeature.score({ pricing_views: 3, days_since_last_pricing_view: 7 });
    const stale = pricingIntentFeature.score({ pricing_views: 3, days_since_last_pricing_view: 60 });
    expect(today.value).toBeGreaterThan(lastWeek.value);
    expect(lastWeek.value).toBeGreaterThan(stale.value);
    // Scoring the raw count would keep a months-old lead permanently hot.
    expect(stale.value).toBe(0);
  });

  it('a very young domain scores low and says why', () => {
    const young = domainAgeFeature.score({ domain_age_days: 3 });
    expect(young.value).toBeLessThan(0.05);
    expect(young.explanation).toMatch(/throwaway or fraudulent/);
  });

  it('form completeness names the missing fields', () => {
    const r = formCompletenessFeature.score({
      requested_fields: ['email', 'company', 'phone', 'role'],
      provided_fields: ['email', 'Company'],
    });
    expect(r.value).toBeCloseTo(0.5, 5);
    expect(r.explanation).toMatch(/missing phone, role/);
  });

  it('every feature output stays within 0..1 even on absurd input', () => {
    const absurd = [
      companySizeFeature.score({ employee_count: 9_999_999, ideal_min: 1, ideal_max: 2 }),
      domainAgeFeature.score({ domain_age_days: 10_000_000 }),
      pricingIntentFeature.score({ pricing_views: 9999, days_since_last_pricing_view: -5 }),
    ];
    for (const r of absurd) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoring explains feature attribution per result (AC4)', () => {
  const signals = {
    company_size: { employee_count: 200, ideal_min: 10, ideal_max: 1000 },
    pricing_intent: { pricing_views: 3, days_since_last_pricing_view: 1 },
    source_quality: { source: 'referral', source_quality_map: { referral: 0.9 } },
  };

  it('returns raw, weight, contribution and an explanation for each feature', () => {
    const { attribution } = evaluateB2BFeatures(signals, DEFAULT_B2B_WEIGHTS);
    for (const a of attribution) {
      expect(typeof a.raw).toBe('number');
      expect(typeof a.weight).toBe('number');
      expect(a.contribution).toBeCloseTo(a.evidence ? a.raw * a.weight : 0, 4);
      expect(a.explanation.length).toBeGreaterThan(0);
      expect(['firmographic', 'intent', 'quality']).toContain(a.family);
    }
  });

  it('is ordered by what actually moved the score', () => {
    const { attribution } = evaluateB2BFeatures(signals, DEFAULT_B2B_WEIGHTS);
    // The first entry answers "why this score" without the reader scanning the list.
    for (let i = 1; i < attribution.length; i += 1) {
      expect(attribution[i - 1].contribution).toBeGreaterThanOrEqual(attribution[i].contribution);
    }
    expect(attribution[0].evidence).toBe(true);
  });

  it('the subtotal equals the sum of the evidenced contributions', () => {
    const { attribution, subtotal } = evaluateB2BFeatures(signals, DEFAULT_B2B_WEIGHTS);
    const summed = attribution.reduce((acc, a) => acc + a.contribution, 0);
    expect(subtotal).toBeCloseTo(summed, 4);
  });

  it('only features the model carries a weight for are evaluated', () => {
    // A model that registered just one B2B feature must not silently gain the other nine.
    const { attribution } = evaluateB2BFeatures(signals, { b2b_pricing_intent: 1 });
    expect(attribution).toHaveLength(1);
    expect(attribution[0].feature).toBe('b2b_pricing_intent');
  });
});
