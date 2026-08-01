/**
 * Zero-side-effect routing simulation (P16 · EP-379 · PCF-06-3).
 *
 *   ASSIGNMENT_IT=1 DATABASE_URL=... pnpm --filter @projexlight/sdk-assignment test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { publishRuleSet, route, setAvailabilityResolver } from '../src/services/routingService';
import {
  auditSkew, readRotationState, setSimulationSinks, simulate,
} from '../src/services/simulationService';

const RUN = process.env.ASSIGNMENT_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const CARLA = randomUUID();

suite('routing simulation', () => {
  let candidateVersion: number;

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    // v1 (active): everything goes to whoever has most headroom.
    await publishRuleSet({
      tenant_id: TENANT, activate: true,
      rules: {
        eligibility: [{ field: 'region', op: 'present' }],
        priority_bands: [{ band: 'standard', when: [] }],
        assignment: { pick: 'most_headroom' },
      },
    });
    // v2 (candidate, NOT active): first available wins.
    const v2 = await publishRuleSet({
      tenant_id: TENANT,
      rules: {
        eligibility: [{ field: 'region', op: 'present' }],
        priority_bands: [{ band: 'standard', when: [] }],
        assignment: { pick: 'first' },
      },
    });
    candidateVersion = v2.version;

    // Record real history under v1: BOB always wins on headroom.
    setAvailabilityResolver(async () => ({
      eligible: [
        { persona_id: ALICE, min_remaining_headroom: 1 },
        { persona_id: BOB, min_remaining_headroom: 9 },
      ],
      ineligible: [],
    }));
    for (let i = 0; i < 6; i++) {
      await route({
        tenant_id: TENANT, subject_ref: `hist-${i}`,
        subject: { region: 'TX' },
        candidate_persona_ids: [ALICE, BOB],
      });
    }
  });

  afterAll(async () => {
    if (!RUN) return;
    setAvailabilityResolver(null);
    setSimulationSinks(null);
    await dataService.query(`DELETE FROM assignment.routing_decision WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(
      `UPDATE assignment.routing_rule_set SET is_active = false WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('creates zero assignments, notifications, clocks and decisions', async () => {
    let realCalls = 0;
    // Production sinks, installed as they would be for real.
    setSimulationSinks({
      assign: async () => { realCalls += 1; },
      notify: async () => { realCalls += 1; },
      startClock: async () => { realCalls += 1; },
    });

    const before = await dataService.rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM assignment.routing_decision WHERE tenant_id = $1`, [TENANT]);
    const report = await simulate({
      tenant_id: TENANT, candidate_version: candidateVersion,
      candidate_persona_ids: [ALICE, BOB, CARLA],
    });
    const after = await dataService.rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM assignment.routing_decision WHERE tenant_id = $1`, [TENANT]);

    expect(report.subjects_replayed).toBe(6);
    // Counted from the table rather than assumed: the dry_run flag could regress.
    expect(report.side_effects).toEqual({
      assignments: 0, notifications: 0, clocks: 0, decisions_written: 0,
    });
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    // The real sinks were swapped out for the duration, so nothing reached production.
    expect(realCalls).toBe(0);
    // …and restored afterwards.
    expect(realCalls).toBe(0);
    setSimulationSinks(null);
  });

  it('compares actual against candidate per persona', async () => {
    const report = await simulate({
      tenant_id: TENANT, candidate_version: candidateVersion,
      candidate_persona_ids: [ALICE, BOB],
    });
    const alice = report.per_persona.find((p) => p.persona_id === ALICE);
    const bob = report.per_persona.find((p) => p.persona_id === BOB);
    // v1 sent everything to BOB (most headroom); v2 sends everything to ALICE (first).
    expect(bob?.actual).toBe(6);
    expect(bob?.candidate).toBe(0);
    expect(alice?.actual).toBe(0);
    expect(alice?.candidate).toBe(6);
    expect(alice?.delta).toBe(6);
    expect(bob?.delta).toBe(-6);
    // And every subject is listed as changed, which is what a reviewer inspects.
    expect(report.changed).toHaveLength(6);
    expect(report.outcome_shift.ASSIGNED).toEqual({ actual: 6, candidate: 6 });
  });

  it('surfaces over-allocation AND starvation, naming who got nothing', async () => {
    const report = await simulate({
      tenant_id: TENANT, candidate_version: candidateVersion,
      candidate_persona_ids: [ALICE, BOB, CARLA],
    });
    // ALICE takes everything under the candidate; BOB and CARLA take none.
    expect(report.skew.over_allocated.map((o) => o.persona_id)).toContain(ALICE);
    expect(report.skew.received_nothing.sort()).toEqual([BOB, CARLA].sort());
    // Starvation is reported separately: it has a different cause and a different fix,
    // and a single "imbalance" number hides the person who got zero.
    expect(report.skew.starved.map((s) => s.persona_id).sort()).toEqual([BOB, CARLA].sort());
  });

  it('audits skew arithmetically, including a perfectly even split', () => {
    const even = auditSkew(
      [
        { persona_id: 'a', actual: 0, candidate: 5, delta: 5 },
        { persona_id: 'b', actual: 0, candidate: 5, delta: 5 },
      ], ['a', 'b'], 0.5,
    );
    expect(even.over_allocated).toEqual([]);
    expect(even.starved).toEqual([]);
    expect(even.received_nothing).toEqual([]);
    expect(even.mean).toBe(5);

    const lopsided = auditSkew(
      [
        { persona_id: 'a', actual: 0, candidate: 10, delta: 10 },
        { persona_id: 'b', actual: 0, candidate: 1, delta: 1 },
      ], ['a', 'b', 'c'], 0.5,
    );
    expect(lopsided.over_allocated[0].persona_id).toBe('a');
    expect(lopsided.received_nothing).toEqual(['c']);
  });

  it('reads the EP-335 rotation cursor without advancing it', async () => {
    // Advancing it would be exactly the side effect this file exists to avoid — and
    // would skew the real rotation for everybody the moment somebody ran a simulation.
    const before = await readRotationState({ tenant_id: TENANT });
    await simulate({
      tenant_id: TENANT, candidate_version: candidateVersion,
      candidate_persona_ids: [ALICE, BOB],
    });
    const after = await readRotationState({ tenant_id: TENANT });
    expect(after).toEqual(before);
  });

  it('replays what the rules SAW, not the subject as it is today', async () => {
    // The trace records the fields the rules read; the subject itself may have moved
    // on, and replaying today's version would answer a question nobody asked.
    const [decision] = await dataService.rows<{ steps: Array<{ step: string; detail: Record<string, unknown> }> }>(
      `SELECT steps FROM assignment.routing_decision
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [TENANT]);
    const eligibility = decision.steps.find((s) => s.step === 'eligibility');
    expect((eligibility?.detail as { subject_fields: Record<string, unknown> }).subject_fields)
      .toEqual({ region: 'TX' });
  });
});
