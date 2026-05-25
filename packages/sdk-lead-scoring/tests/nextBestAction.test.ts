import { describe, it, expect, afterEach } from 'vitest';
import {
  nextBestAction,
  setNextBestActionResolver,
  _resetNextBestActionResolver,
  type ScoreContactResult,
} from '../src/services/scoringEngine';
import type { LeadScoreRef } from '@projexlight/contracts';

function mockScore(components: ScoreContactResult['components']): ScoreContactResult {
  const score: LeadScoreRef = {
    score_id: 'mock-score',
    model_id: 'mock-model',
    contact_id: 'mock-contact',
    score: 42,
    components,
    computed_at: new Date().toISOString(),
    trace_id: 'mock-trace',
  };
  return { score, components, weights: {}, model_id: 'mock-model' };
}

describe('sdk-lead-scoring nextBestAction (default resolver)', () => {
  afterEach(() => _resetNextBestActionResolver());

  it('recommends storm_response when storm impact >= 0.5', async () => {
    const r = await nextBestAction(
      mockScore({ proximity: 0.9, expertise: 0.9, intent: 0.9, storm_impact: 0.6 }),
    );
    expect(r.action).toBe('storm_response');
    expect(r.driver).toBe('storm_impact');
  });

  it('recommends schedule_visit when proximity dominates and no storm', async () => {
    const r = await nextBestAction(
      mockScore({ proximity: 0.8, expertise: 0.2, intent: 0.3, storm_impact: 0 }),
    );
    expect(r.action).toBe('schedule_visit');
    expect(r.driver).toBe('proximity');
  });

  it('recommends send_offer when expertise dominates', async () => {
    const r = await nextBestAction(
      mockScore({ proximity: 0.2, expertise: 0.9, intent: 0.3, storm_impact: 0 }),
    );
    expect(r.action).toBe('send_offer');
  });

  it('recommends reach_out when intent dominates', async () => {
    const r = await nextBestAction(
      mockScore({ proximity: 0.2, expertise: 0.3, intent: 0.9, storm_impact: 0 }),
    );
    expect(r.action).toBe('reach_out');
  });

  it('recommends nurture when all subscores are zero', async () => {
    const r = await nextBestAction(
      mockScore({ proximity: 0, expertise: 0, intent: 0, storm_impact: 0 }),
    );
    expect(r.action).toBe('nurture');
  });

  it('honors a custom resolver via setNextBestActionResolver', async () => {
    setNextBestActionResolver(async () => ({
      action: 'nurture',
      reason: 'custom resolver',
      driver: 'intent',
      driver_score: 0,
    }));
    const r = await nextBestAction(
      mockScore({ proximity: 0.99, expertise: 0, intent: 0, storm_impact: 0 }),
    );
    expect(r.reason).toBe('custom resolver');
  });
});
