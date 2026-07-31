import { describe, expect, it } from 'vitest';
import {
  evaluateCapacity,
  makeQueryLoadProvider,
  type CapacityPolicy,
} from '../src/services/capacityService';
import { gapsBetween } from '../src/services/onCallService';

/**
 * The two pieces where a mistake is silent rather than loud: headroom arithmetic
 * (a wrong answer routes work to somebody already buried) and gap detection (a
 * missed gap is discovered by an unanswered page).
 */

function policy(over: Partial<CapacityPolicy> = {}): CapacityPolicy {
  return {
    capacity_policy_id: 'p1',
    tenant_id: 't1',
    persona_id: 'a',
    role_ref: null,
    max_concurrent_by_band: { urgent: 2, standard: 8 },
    freeze_threshold: 1,
    freeze_threshold_by_band: {},
    daily_cap: null,
    is_active: true,
    ...over,
  };
}

const policies = (p: CapacityPolicy): Map<string, CapacityPolicy> => new Map([['a', p]]);

describe('capacity evaluation', () => {
  it('reports headroom per band', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy()),
      load: { a: { urgent: 1, standard: 3 } },
    });
    expect(a.bands.find((b) => b.band === 'urgent')).toMatchObject({ limit: 2, load: 1, headroom: 1, frozen: false });
    expect(a.bands.find((b) => b.band === 'standard')).toMatchObject({ limit: 8, load: 3, headroom: 5 });
    expect(a.total_load).toBe(4);
    expect(a.fully_frozen).toBe(false);
  });

  it('freezes a band at its limit', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy()),
      load: { a: { urgent: 2, standard: 1 } },
    });
    expect(a.bands.find((b) => b.band === 'urgent')?.frozen).toBe(true);
    // One band frozen is not fully frozen — they can still take standard work.
    expect(a.fully_frozen).toBe(false);
  });

  it('is fully frozen only when every capped band is', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy()),
      load: { a: { urgent: 2, standard: 8 } },
    });
    expect(a.fully_frozen).toBe(true);
  });

  it('honours a per-band freeze threshold', () => {
    // Stop at 50% of standard: 4 of 8 is already frozen, deliberately reserving headroom.
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ freeze_threshold_by_band: { standard: 0.5 } })),
      load: { a: { standard: 4 } },
    });
    expect(a.bands.find((b) => b.band === 'standard')).toMatchObject({ frozen: true, headroom: 4 });
  });

  it('applies the global threshold when a band has no override', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ freeze_threshold: 0.5 })),
      load: { a: { urgent: 1 } },
    });
    expect(a.bands.find((b) => b.band === 'urgent')?.frozen).toBe(true);
  });

  it('treats a band absent from the policy as UNCAPPED, not as zero', () => {
    // The distinction that matters: "not mentioned" must not silently freeze a
    // band the tenant never thought to list.
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ max_concurrent_by_band: { urgent: 2 } })),
      load: { a: { bulk: 400 } },
    });
    const bulk = a.bands.find((b) => b.band === 'bulk');
    expect(bulk).toMatchObject({ limit: null, headroom: null, frozen: false });
  });

  it('expresses capped-at-zero as frozen at zero load', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ max_concurrent_by_band: { urgent: 0 } })),
      load: { a: {} },
    });
    expect(a.bands.find((b) => b.band === 'urgent')).toMatchObject({ limit: 0, frozen: true, headroom: 0 });
  });

  it('a persona with no policy is uncapped and never frozen', () => {
    const [a] = evaluateCapacity({ persona_ids: ['a'], policies: new Map(), load: { a: { urgent: 99 } } });
    expect(a.has_policy).toBe(false);
    expect(a.fully_frozen).toBe(false);
  });

  it('distinguishes measured-zero from not-measured', () => {
    // findEligible depends on this: not-measured is CAPACITY_UNKNOWN and excluded;
    // measured-zero is full headroom and eligible.
    const [measured] = evaluateCapacity({ persona_ids: ['a'], policies: policies(policy()), load: { a: {} } });
    const [unmeasured] = evaluateCapacity({ persona_ids: ['a'], policies: policies(policy()), load: {} });
    expect(measured.measured).toBe(true);
    expect(unmeasured.measured).toBe(false);
  });

  it('freezes on the daily cap regardless of band headroom', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ daily_cap: 5 })),
      load: { a: { urgent: 1, standard: 4 } },
    });
    expect(a.fully_frozen).toBe(true);
  });

  it('clamps a threshold above 1.0 rather than assigning past the limit', () => {
    const [a] = evaluateCapacity({
      persona_ids: ['a'],
      policies: policies(policy({ freeze_threshold: 1.5 })),
      load: { a: { urgent: 2 } },
    });
    expect(a.bands.find((b) => b.band === 'urgent')?.frozen).toBe(true);
  });
});

describe('makeQueryLoadProvider', () => {
  it('refuses a table or column that is not a plain identifier', () => {
    // These are interpolated, not bound. The guard is what makes an accidentally
    // request-derived value fail loudly instead of executing.
    expect(() =>
      makeQueryLoadProvider({
        table: 'assignment.workload; DROP TABLE x',
        personaColumn: 'persona_id',
        tenantColumn: 'tenant_id',
        openPredicate: 'true',
      }),
    ).toThrow(/plain SQL identifier/);

    expect(() =>
      makeQueryLoadProvider({
        table: 'assignment.workload',
        personaColumn: 'persona_id",',
        tenantColumn: 'tenant_id',
        openPredicate: 'true',
      }),
    ).toThrow(/plain SQL identifier/);
  });

  it('accepts an ordinary schema-qualified table', () => {
    expect(() =>
      makeQueryLoadProvider({
        table: 'assignment.workload',
        personaColumn: 'assignee_persona_id',
        tenantColumn: 'tenant_id',
        bandColumn: 'priority_band',
        openPredicate: "status IN ('open','accepted')",
      }),
    ).not.toThrow();
  });
});

describe('roster gap detection', () => {
  const H = 3_600_000;
  const from = 0;
  const to = 24 * H;

  it('reports the whole window when nobody is on call', () => {
    expect(gapsBetween([], from, to)).toEqual([
      { starts_at: new Date(0).toISOString(), ends_at: new Date(24 * H).toISOString(), minutes: 1440 },
    ]);
  });

  it('reports nothing when the window is fully covered', () => {
    expect(gapsBetween([{ start: from, end: to }], from, to)).toEqual([]);
  });

  it('reports no gap for an exact handover', () => {
    // The normal shape of a clean shift change. A zero-length gap here would bury
    // the real ones under one per changeover.
    const gaps = gapsBetween(
      [
        { start: 0, end: 12 * H },
        { start: 12 * H, end: 24 * H },
      ],
      from,
      to,
    );
    expect(gaps).toEqual([]);
  });

  it('finds a gap between two shifts', () => {
    const gaps = gapsBetween(
      [
        { start: 0, end: 8 * H },
        { start: 10 * H, end: 24 * H },
      ],
      from,
      to,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(120);
  });

  it('finds a leading and a trailing gap', () => {
    const gaps = gapsBetween([{ start: 2 * H, end: 22 * H }], from, to);
    expect(gaps.map((g) => g.minutes)).toEqual([120, 120]);
  });

  it('handles an interval that starts before the window', () => {
    const gaps = gapsBetween([{ start: -5 * H, end: 6 * H }], from, to);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].starts_at).toBe(new Date(6 * H).toISOString());
  });

  it('handles overlapping and swallowed intervals', () => {
    const gaps = gapsBetween(
      [
        { start: 0, end: 10 * H },
        { start: 2 * H, end: 4 * H }, // entirely inside the first
        { start: 9 * H, end: 24 * H }, // overlaps the first
      ],
      from,
      to,
    );
    expect(gaps).toEqual([]);
  });

  it('ignores intervals entirely outside the window', () => {
    const gaps = gapsBetween(
      [
        { start: -10 * H, end: -1 * H },
        { start: 30 * H, end: 40 * H },
      ],
      from,
      to,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(1440);
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(gapsBetween([], 10, 10)).toEqual([]);
    expect(gapsBetween([], 20, 10)).toEqual([]);
  });

  it('clips a gap to the window rather than reporting past it', () => {
    const gaps = gapsBetween([{ start: 30 * H, end: 40 * H }], from, to);
    expect(gaps[0].ends_at).toBe(new Date(to).toISOString());
  });
});
