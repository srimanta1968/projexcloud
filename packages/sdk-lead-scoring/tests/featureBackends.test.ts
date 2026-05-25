import { describe, it, expect } from 'vitest';
import {
  DistanceDecayProximity,
  SetMembershipExpertise,
  RecencyIntent,
  ThresholdStormImpact,
} from '../src/services/featureBackends';

describe('sdk-lead-scoring feature backends', () => {
  describe('DistanceDecayProximity', () => {
    const b = new DistanceDecayProximity(25);

    it('returns 1.0 at distance 0', async () => {
      expect(await b.score({ distance_km: 0 })).toBeCloseTo(1.0, 6);
    });

    it('returns 0.5 at the decay distance', async () => {
      expect(await b.score({ distance_km: 25 })).toBeCloseTo(0.5, 6);
    });

    it('returns 0.2 at 4× decay distance', async () => {
      expect(await b.score({ distance_km: 100 })).toBeCloseTo(0.2, 6);
    });

    it('returns 0.5 when no distance supplied (deterministic default)', async () => {
      expect(await b.score({})).toBe(0.5);
    });

    it('honors override', async () => {
      expect(await b.score({ override: 0.42 })).toBe(0.42);
    });

    it('clamps negative distance to 0', async () => {
      expect(await b.score({ distance_km: -50 })).toBe(1);
    });
  });

  describe('SetMembershipExpertise', () => {
    const b = new SetMembershipExpertise();

    it('returns 1.0 when all specialties matched', async () => {
      expect(
        await b.score({
          persona_kinds: ['roof', 'flood', 'unrelated'],
          vertical_specialties: ['roof', 'flood'],
        }),
      ).toBe(1);
    });

    it('returns fractional score on partial match', async () => {
      expect(
        await b.score({
          persona_kinds: ['roof'],
          vertical_specialties: ['roof', 'flood', 'fire', 'wind'],
        }),
      ).toBeCloseTo(0.25, 6);
    });

    it('returns 0 when no overlap', async () => {
      expect(
        await b.score({
          persona_kinds: ['hvac'],
          vertical_specialties: ['roof', 'flood'],
        }),
      ).toBe(0);
    });

    it('returns 0.5 when no specialties configured (neutral prior)', async () => {
      expect(await b.score({ persona_kinds: ['anything'] })).toBe(0.5);
    });
  });

  describe('RecencyIntent', () => {
    const b = new RecencyIntent(14);

    it('returns ~0 when no engagement signals', async () => {
      expect(await b.score({})).toBe(0);
    });

    it('decays exponentially with days since engagement', async () => {
      const fresh = await b.score({ days_since_last_engagement: 0 });
      const halfLife = await b.score({ days_since_last_engagement: 14 });
      const twoHalfLives = await b.score({ days_since_last_engagement: 28 });
      expect(fresh).toBeGreaterThan(halfLife);
      expect(halfLife).toBeGreaterThan(twoHalfLives);
    });

    it('boosts on engagement counts', async () => {
      const none = await b.score({ days_since_last_engagement: 7 });
      const some = await b.score({ days_since_last_engagement: 7, emails_opened: 5, replies: 2 });
      expect(some).toBeGreaterThan(none);
    });

    it('honors override', async () => {
      expect(await b.score({ override: 0.9, days_since_last_engagement: 999 })).toBe(0.9);
    });
  });

  describe('ThresholdStormImpact', () => {
    const b = new ThresholdStormImpact();

    it('returns 0 when no overlapping storms', async () => {
      expect(await b.score({ overlapping_storm_events: 0 })).toBe(0);
    });

    it('returns 1 when at least one overlap', async () => {
      expect(await b.score({ overlapping_storm_events: 1 })).toBe(1);
      expect(await b.score({ overlapping_storm_events: 17 })).toBe(1);
    });

    it('honors override', async () => {
      expect(await b.score({ override: 0.25 })).toBe(0.25);
    });
  });
});
