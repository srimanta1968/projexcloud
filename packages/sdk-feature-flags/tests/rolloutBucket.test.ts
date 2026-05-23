/**
 * FR-FF-3 unit test: % rollout bucket is (a) deterministic per (flag, subject)
 * and (b) approximately uniform across subjects so a 50% rollout actually
 * hits ~half the population.
 */
import { describe, expect, it } from 'vitest';
import { rolloutBucket } from '../src/services/featureFlagsService';

describe('rolloutBucket', () => {
  it('returns 0..99 inclusive', () => {
    for (let i = 0; i < 1000; i++) {
      const b = rolloutBucket('flag.x', `subject-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('is deterministic for the same (flag, subject) pair', () => {
    const a = rolloutBucket('agent.cost-steward.enabled', 'tenant-42');
    const b = rolloutBucket('agent.cost-steward.enabled', 'tenant-42');
    expect(a).toBe(b);
  });

  it('changes when flag_id changes (no cross-flag bleed)', () => {
    const a = rolloutBucket('flag.a', 'tenant-42');
    const b = rolloutBucket('flag.b', 'tenant-42');
    // Hash space is large so collisions are rare; assert at least one of 10
    // unrelated flag_ids produces a different bucket for the same subject.
    let differed = false;
    for (let i = 0; i < 10; i++) {
      if (rolloutBucket(`flag.${i}`, 'tenant-42') !== a) differed = true;
    }
    expect(differed).toBe(true);
    expect(a).not.toBe(b); // these two specifically should differ
  });

  it('is approximately uniform — 50% rollout includes 45–55% of 5k subjects', () => {
    let inRollout = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (rolloutBucket('flag.uniform-test', `s-${i}`) < 50) inRollout++;
    }
    const pct = (inRollout / N) * 100;
    expect(pct).toBeGreaterThan(45);
    expect(pct).toBeLessThan(55);
  });
});
