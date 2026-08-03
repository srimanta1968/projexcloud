/**
 * The six-step routing pipeline and its trace (P16 · EP-379 · PCF-06-1).
 *
 * The four criteria, each tested for the failure it exists to prevent:
 *   * every call returns a per-step trace — an operator has to be able to answer
 *     "why did this go there" months later, from what was written down at the time;
 *   * AMBIGUOUS eligibility goes to REVIEW, never a forced assignment — a forced
 *     assignment on ambiguous input looks identical to a correct one in every
 *     dashboard, so the error is invisible exactly when it matters;
 *   * rules are versioned DATA, changed without a deploy, and a published version is
 *     frozen so an old decision still explains itself with the rules that produced it;
 *   * the pre-existing assign-by-task contract is untouched.
 *
 *   ASSIGNMENT_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-assignment test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  activateRuleSet,
  getActiveRuleSet,
  getDecision,
  hasAvailabilityResolver,
  listDecisions,
  listRuleSetVersions,
  publishRuleSet,
  route,
  setAvailabilityResolver,
  type RuleSetBody,
} from '../src/services/routingService';

const RUN = process.env.ASSIGNMENT_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const CATCHER = randomUUID();

const BASE_RULES: RuleSetBody = {
  eligibility: [
    { field: 'region', op: 'present', because: 'a subject with no region cannot be routed' },
  ],
  priority_bands: [
    { band: 'urgent', when: [{ field: 'severity', op: 'gte', value: 8 }] },
    { band: 'standard', when: [] },
  ],
  specialty: { field: 'required_specialty' },
  assignment: { pick: 'most_headroom' },
  fallback: { persona_id: CATCHER },
};

const available = (
  eligible: Array<[string, number | null]>,
  ineligible: Array<[string, string]> = [],
): void => {
  setAvailabilityResolver(async () => ({
    eligible: eligible.map(([persona_id, headroom]) => ({
      persona_id, min_remaining_headroom: headroom,
    })),
    ineligible: ineligible.map(([persona_id, code]) => ({
      persona_id, reasons: [{ code, detail: code }],
    })),
  }));
};

suite('six-step routing pipeline', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    await publishRuleSet({ tenant_id: TENANT, rules: BASE_RULES, activate: true, published_by: 'qa' });
  });

  afterEach(() => setAvailabilityResolver(null));

  afterAll(async () => {
    if (!RUN) return;
    setAvailabilityResolver(null);
    await dataService.query(`DELETE FROM assignment.routing_decision WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(
      `UPDATE assignment.routing_rule_set SET is_active = false WHERE tenant_id = $1`, [TENANT]);
    // The rule sets themselves are frozen by trigger and stay — past decisions point
    // at them, which is the whole reason they cannot be deleted.
    await closeAllPools();
  });

  it('returns a step-by-step trace on every call, and persists it', async () => {
    available([[ALICE, 2], [BOB, 5]]);
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-trace',
      subject: { region: 'TX', severity: 9 },
      candidate_persona_ids: [ALICE, BOB],
    });

    expect(result.outcome).toBe('ASSIGNED');
    // Most headroom first: BOB has 5, ALICE has 2.
    expect(result.chosen_persona_id).toBe(BOB);
    expect(result.priority_band).toBe('urgent');
    expect(result.trace.map((s) => s.step)).toEqual([
      'eligibility', 'priority', 'specialty', 'availability', 'assignment',
    ]);
    for (const step of result.trace) {
      expect(step.explanation.length, `${step.step} must explain itself`).toBeGreaterThan(10);
    }

    // Written down AT THE TIME: re-running the pipeline today would answer a
    // different question, because the rules and everybody's availability move on.
    const persisted = await getDecision(TENANT, result.decision_id as string);
    expect(persisted?.outcome).toBe('ASSIGNED');
    expect(persisted?.steps.map((s) => s.step)).toEqual(result.trace.map((s) => s.step));
    expect(persisted?.rule_set_version).toBe(result.rule_set_version);
  });

  it('sends AMBIGUOUS eligibility to review rather than force-assigning', async () => {
    available([[ALICE, 5]]);
    await publishRuleSet({
      tenant_id: TENANT, name: 'ambiguous', activate: true,
      rules: {
        // The subject below carries no 'segment', so this rule cannot be ANSWERED —
        // which is different from being answered "no".
        eligibility: [{ field: 'segment', op: 'equals', value: 'enterprise' }],
        fallback: { persona_id: CATCHER },
      },
    });

    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-ambiguous', rule_set_name: 'ambiguous',
      subject: { region: 'TX' },
      candidate_persona_ids: [ALICE],
    });

    expect(result.outcome).toBe('REVIEW');
    expect(result.chosen_persona_id).toBeNull();
    expect(result.trace[0].result).toBe('review');
    expect(result.trace[0].explanation).toMatch(/could not be decided/);
    // It stopped at step 1: nothing downstream got to pretend it had an answer.
    expect(result.trace).toHaveLength(1);
  });

  it('distinguishes "not eligible" from "cannot tell"', async () => {
    available([[ALICE, 5]]);
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-ineligible', rule_set_name: 'ambiguous',
      subject: { segment: 'smb' },
      candidate_persona_ids: [ALICE],
    });
    // The rule COULD be answered, and the answer was no.
    expect(result.outcome).toBe('UNROUTABLE');
    expect(result.trace[0].result).toBe('fail');
  });

  it('goes to review when availability cannot be checked at all', async () => {
    // Unwired must not mean "everybody is free": that routes work to people on PTO
    // and at capacity, and the first sign is an unanswered subject.
    expect(hasAvailabilityResolver()).toBe(false);
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-nocoverage',
      subject: { region: 'TX', severity: 2 },
      candidate_persona_ids: [ALICE],
    });
    expect(result.outcome).toBe('REVIEW');
    expect(result.trace.at(-1)?.step).toBe('availability');
    expect(result.trace.at(-1)?.explanation).toMatch(/no coverage resolver is wired/);
  });

  it('carries the REASONS a candidate was skipped, not just the count', async () => {
    available([], [[ALICE, 'AT_CAPACITY'], [BOB, 'TIME_OFF']]);
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-why',
      subject: { region: 'TX', severity: 1 },
      candidate_persona_ids: [ALICE, BOB],
    });
    const availability = result.trace.find((s) => s.step === 'availability');
    expect(availability?.result).toBe('fail');
    // "Why was this person skipped" is the question the trace exists to answer.
    expect(JSON.stringify(availability?.detail)).toMatch(/AT_CAPACITY/);
    expect(JSON.stringify(availability?.detail)).toMatch(/TIME_OFF/);
    expect(result.outcome).toBe('FALLBACK');
    expect(result.chosen_persona_id).toBe(CATCHER);
  });

  it('narrows by specialty and says how many survived', async () => {
    available([[ALICE, 3]]);
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-specialty',
      subject: { region: 'TX', severity: 1, required_specialty: 'roofing' },
      candidate_persona_ids: [ALICE, BOB],
      persona_specialties: { [ALICE]: ['roofing', 'siding'], [BOB]: ['plumbing'] },
    });
    const specialty = result.trace.find((s) => s.step === 'specialty');
    expect(specialty?.candidates).toEqual([ALICE]);
    expect(specialty?.explanation).toMatch(/1 of 2/);
    expect(result.chosen_persona_id).toBe(ALICE);
  });

  it('changes behaviour by publishing a new rule version — no deploy', async () => {
    available([[ALICE, 1], [BOB, 9]]);
    const before = await route({
      tenant_id: TENANT, subject_ref: 'subj-version',
      subject: { region: 'TX', severity: 1 },
      candidate_persona_ids: [ALICE, BOB],
    });
    expect(before.chosen_persona_id).toBe(BOB); // most headroom

    const v2 = await publishRuleSet({
      tenant_id: TENANT, activate: true,
      rules: { ...BASE_RULES, assignment: { pick: 'first' } },
    });
    const after = await route({
      tenant_id: TENANT, subject_ref: 'subj-version',
      subject: { region: 'TX', severity: 1 },
      candidate_persona_ids: [ALICE, BOB],
    });
    // Same code, same inputs, different answer — because the rules are data.
    expect(after.chosen_persona_id).toBe(ALICE);
    expect(after.rule_set_version).toBe(v2.version);
    expect(after.rule_set_version).toBeGreaterThan(before.rule_set_version as number);

    // And the OLD decision still names the version that produced it.
    const old = await getDecision(TENANT, before.decision_id as string);
    expect(old?.rule_set_version).toBe(before.rule_set_version);
  });

  it('freezes a published version instead of letting it be edited', async () => {
    const active = await getActiveRuleSet(TENANT);
    let message = '';
    try {
      await dataService.query(
        `UPDATE assignment.routing_rule_set SET rules = '{}'::jsonb WHERE rule_set_id = $1`,
        [active!.rule_set_id],
      );
    } catch (err) { message = (err as Error).message; }
    // Otherwise last month's decision would explain itself with this month's rules —
    // a confident wrong answer, which is worse than none.
    expect(message).toMatch(/frozen/);
  });

  it('keeps exactly one active version, and can roll back to an earlier one', async () => {
    const versions = await listRuleSetVersions(TENANT);
    expect(versions.filter((v) => v.is_active)).toHaveLength(1);
    const rolledBack = await activateRuleSet({ tenant_id: TENANT, version: 1 });
    expect(rolledBack.version).toBe(1);
    expect((await listRuleSetVersions(TENANT)).filter((v) => v.is_active)).toHaveLength(1);
  });

  it('writes nothing on a dry run', async () => {
    available([[ALICE, 4]]);
    const before = (await listDecisions({ tenant_id: TENANT, limit: 500 })).length;
    const result = await route({
      tenant_id: TENANT, subject_ref: 'subj-dry',
      subject: { region: 'TX', severity: 1 },
      candidate_persona_ids: [ALICE],
      dry_run: true,
    });
    expect(result.decision_id).toBeNull();
    // The simulation lane depends on this: a dry run that recorded decisions would
    // pollute the very history it is being compared against.
    expect((await listDecisions({ tenant_id: TENANT, limit: 500 })).length).toBe(before);
  });

  it('lists review decisions so an operator can work the queue', async () => {
    const review = await listDecisions({ tenant_id: TENANT, outcome: 'REVIEW', limit: 50 });
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((d) => d.outcome === 'REVIEW')).toBe(true);
  });
});
