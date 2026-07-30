/**
 * Policy and clock lifecycle (P16 · EP-376 · PCF-03-2).
 *
 * Opt-in: SLA_IT=1 plus a reachable Postgres — the immutability rules that matter
 * most here are enforced by database triggers, so testing them without a database
 * would test nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { createCalendar, getCalendar } from '../src/services/calendarService';
import {
  createPolicy,
  startClock,
  getClock,
  pauseClock,
  resumeClock,
  satisfyClock,
  cancelClock,
  reassignClock,
  mergeClocks,
  subjectQualifies,
  elapsedBusinessMinutes,
  findOverdueClocks,
  listClocks,
  SatisfactionEvidenceInsufficient,
  PauseReasonNotAllowed,
  InvalidClockTransition,
  type SlaPolicy,
} from '../src/services/clockService';

const TENANT = 'c10c0000-0000-4000-8000-00000000abcd';
const RUN_IT = process.env.SLA_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

const ALWAYS_OPEN = {
  '1': [{ start: '00:00', end: '23:59' }], '2': [{ start: '00:00', end: '23:59' }],
  '3': [{ start: '00:00', end: '23:59' }], '4': [{ start: '00:00', end: '23:59' }],
  '5': [{ start: '00:00', end: '23:59' }], '6': [{ start: '00:00', end: '23:59' }],
  '7': [{ start: '00:00', end: '23:59' }],
};

suite('SLA policy and clock lifecycle (integration)', () => {
  let calendarId = '';
  let policy: SlaPolicy;
  const stamp = Date.now();

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    const cal = await createCalendar({
      tenant_id: TENANT,
      slug: `always-open-${stamp}`,
      name: 'Always open',
      timezone: 'UTC',
      working_windows: ALWAYS_OPEN,
      weekend_rule: 'none',
    });
    calendarId = cal.calendar_id;
    policy = await createPolicy({
      tenant_id: TENANT,
      slug: `respond-${stamp}`,
      name: 'Respond promptly',
      subject_kind: 'request',
      duration_minutes: 120,
      calendar_id: calendarId,
      pause_conditions: [{ reason: 'awaiting_subject_reply', max_minutes: 4320 }],
      satisfaction_contract: {
        requires_evidence_ref: true,
        accepted_kinds: ['outbound_reply', 'resolution'],
        requires_actor: true,
      },
    });
  });

  afterAll(async () => {
    await dataService.query(`DELETE FROM sla.sla_clock WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.sla_policy WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.business_calendar WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('computes due_at in business minutes from the SOURCE timestamp', async () => {
    const source = new Date(Date.now() - 30 * 60000).toISOString(); // signal 30m ago
    const { clock, created } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id,
      subject_ref: `subject:${stamp}-due`, source_timestamp: source,
    });
    expect(created).toBe(true);
    expect(new Date(clock.source_timestamp).toISOString()).toBe(new Date(source).toISOString());
    // Due 120 business minutes after the SIGNAL, not after the row was created —
    // so the 30 minutes the platform took to notice are already spent.
    const expectedDue = new Date(new Date(source).getTime() + 120 * 60000).getTime();
    expect(Math.abs(new Date(clock.due_at).getTime() - expectedDue)).toBeLessThan(90_000);
  });

  it('returns the existing live clock instead of starting a second one', async () => {
    const subject = `subject:${stamp}-dup`;
    const first = await startClock({ tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: subject });
    const second = await startClock({ tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: subject });
    expect(second.created).toBe(false);
    expect(second.clock.clock_id).toBe(first.clock.clock_id);
  });

  it('keeps source_timestamp, started_at and due_at through reassignment, takeover and merge', async () => {
    const subject = `subject:${stamp}-survive`;
    const source = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: subject,
      source_timestamp: source, owner_ref: 'owner:first',
    });
    const before = {
      source_timestamp: clock.source_timestamp,
      started_at: clock.started_at,
      due_at: clock.due_at,
    };

    const reassigned = await reassignClock({
      tenant_id: TENANT, clock_id: clock.clock_id, owner_ref: 'owner:second', reason: 'rebalance',
    });
    expect(reassigned.owner_ref).toBe('owner:second');

    const takenOver = await reassignClock({
      tenant_id: TENANT, clock_id: clock.clock_id, owner_ref: 'owner:backup', reason: 'backup takeover',
    });
    expect(takenOver.owner_ref).toBe('owner:backup');

    // A second subject's clock is merged into this one.
    const other = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `${subject}-other`,
    });
    const merged = await mergeClocks({
      tenant_id: TENANT,
      surviving_clock_id: clock.clock_id,
      merged_clock_id: other.clock.clock_id,
    });
    expect(merged.merged.state).toBe('cancelled');
    expect(merged.surviving.merged_from_ref).toBe(`${subject}-other`);

    const after = await getClock(TENANT, clock.clock_id);
    expect({
      source_timestamp: after.source_timestamp,
      started_at: after.started_at,
      due_at: after.due_at,
    }).toEqual(before);
  });

  it('refuses at the DATABASE to move the timing, whoever tries', async () => {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `subject:${stamp}-frozen`,
    });
    for (const column of ['source_timestamp', 'started_at', 'due_at']) {
      let blocked = false;
      try {
        await dataService.query(
          `UPDATE sla.sla_clock SET ${column} = now() + interval '10 days' WHERE clock_id = $1`,
          [clock.clock_id],
        );
      } catch {
        blocked = true;
      }
      expect(blocked, `${column} must be immutable`).toBe(true);
    }
  });

  it('excludes paused time from elapsed business minutes', async () => {
    const subject = `subject:${stamp}-pause`;
    const source = new Date(Date.now() - 60 * 60000).toISOString(); // an hour ago
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: subject, source_timestamp: source,
    });
    const calendar = await getCalendar(TENANT, calendarId);

    const beforePause = await elapsedBusinessMinutes(await getClock(TENANT, clock.clock_id), calendar);
    expect(beforePause).toBeGreaterThanOrEqual(59);

    const paused = await pauseClock({
      tenant_id: TENANT, clock_id: clock.clock_id, reason: 'awaiting_subject_reply',
    });
    expect(paused.state).toBe('paused');

    // Backdate the pause start so there is measurable paused time without waiting.
    await dataService.query(
      `UPDATE sla.sla_clock SET paused_at = now() - interval '30 minutes' WHERE clock_id = $1`,
      [clock.clock_id],
    );
    const whilePaused = await elapsedBusinessMinutes(await getClock(TENANT, clock.clock_id), calendar);
    // Roughly 30 minutes of the hour were parked, so elapsed drops by about that.
    expect(whilePaused).toBeLessThan(beforePause - 25);

    const resumed = await resumeClock({ tenant_id: TENANT, clock_id: clock.clock_id });
    expect(resumed.state).toBe('running');
    expect(resumed.paused_intervals).toHaveLength(1);
    expect(resumed.paused_intervals[0].reason).toBe('awaiting_subject_reply');
    expect(resumed.paused_at).toBeNull();

    const afterResume = await elapsedBusinessMinutes(await getClock(TENANT, clock.clock_id), calendar);
    expect(afterResume).toBeLessThan(beforePause - 25);
  });

  it('refuses a pause reason the policy does not list', async () => {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `subject:${stamp}-badpause`,
    });
    await expect(
      pauseClock({ tenant_id: TENANT, clock_id: clock.clock_id, reason: 'because_i_said_so' }),
    ).rejects.toBeInstanceOf(PauseReasonNotAllowed);
  });

  it('satisfies only on evidence meeting the contract, naming everything missing', async () => {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `subject:${stamp}-satisfy`,
    });

    // Nothing at all: three separate requirements unmet, reported together.
    const bare = satisfyClock({ tenant_id: TENANT, clock_id: clock.clock_id });
    await expect(bare).rejects.toBeInstanceOf(SatisfactionEvidenceInsufficient);
    await expect(bare).rejects.toMatchObject({ status: 422 });
    try {
      await satisfyClock({ tenant_id: TENANT, clock_id: clock.clock_id });
    } catch (err) {
      const missing = (err as SatisfactionEvidenceInsufficient).missing;
      expect(missing.some((m) => /evidence reference/.test(m))).toBe(true);
      expect(missing.some((m) => /evidence kind/.test(m))).toBe(true);
      expect(missing.some((m) => /actor/.test(m))).toBe(true);
    }

    // Evidence of a kind the policy does not accept.
    await expect(
      satisfyClock({
        tenant_id: TENANT, clock_id: clock.clock_id,
        evidence_ref: 'ev-1', evidence_kind: 'internal_note', satisfied_by: 'owner:first',
      }),
    ).rejects.toMatchObject({ code: 'SATISFACTION_EVIDENCE_INSUFFICIENT' });

    // Still running: a refused satisfy must not half-close the promise.
    expect((await getClock(TENANT, clock.clock_id)).state).toBe('running');

    const satisfied = await satisfyClock({
      tenant_id: TENANT, clock_id: clock.clock_id,
      evidence_ref: 'ev-1', evidence_kind: 'outbound_reply', satisfied_by: 'owner:first',
    });
    expect(satisfied.state).toBe('satisfied');
    expect(satisfied.satisfied_at).toBeTruthy();
    expect(satisfied.satisfied_by_evidence_ref).toBe('ev-1');

    // And a satisfied clock cannot be re-satisfied or paused.
    await expect(
      satisfyClock({
        tenant_id: TENANT, clock_id: clock.clock_id,
        evidence_ref: 'ev-2', evidence_kind: 'resolution', satisfied_by: 'owner:first',
      }),
    ).rejects.toBeInstanceOf(InvalidClockTransition);
  });

  it('records a timestamp on every state transition', async () => {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `subject:${stamp}-states`,
    });
    expect(clock.started_at).toBeTruthy();
    const paused = await pauseClock({
      tenant_id: TENANT, clock_id: clock.clock_id, reason: 'awaiting_subject_reply',
    });
    expect(paused.paused_at).toBeTruthy();
    await resumeClock({ tenant_id: TENANT, clock_id: clock.clock_id });
    const cancelled = await cancelClock({
      tenant_id: TENANT, clock_id: clock.clock_id, reason: 'subject withdrew',
    });
    expect(cancelled.cancelled_at).toBeTruthy();
    expect(cancelled.cancel_reason).toBe('subject withdrew');
  });

  it('finds overdue clocks and lists by owner', async () => {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id,
      subject_ref: `subject:${stamp}-overdue`,
      // A signal from long ago is already past due the moment it is registered.
      source_timestamp: new Date(Date.now() - 10 * 3600_000).toISOString(),
      owner_ref: 'owner:overdue',
    });
    const overdue = await findOverdueClocks(TENANT);
    expect(overdue.some((c) => c.clock_id === clock.clock_id)).toBe(true);
    const byOwner = await listClocks({ tenant_id: TENANT, owner_ref: 'owner:overdue' });
    expect(byOwner.some((c) => c.clock_id === clock.clock_id)).toBe(true);
  });
});

describe('qualifying predicate (pure)', () => {
  it('matches everything when empty — a policy with no qualifier covers its kind', () => {
    expect(subjectQualifies({}, { anything: 1 })).toBe(true);
    expect(subjectQualifies({ all: [] }, {})).toBe(true);
  });

  it('evaluates each supported operator', () => {
    const attrs = { priority: 'high', score: 80, owner: 'o1', note: '' };
    expect(subjectQualifies({ all: [{ field: 'priority', op: 'eq', value: 'high' }] }, attrs)).toBe(true);
    expect(subjectQualifies({ all: [{ field: 'priority', op: 'ne', value: 'high' }] }, attrs)).toBe(false);
    expect(subjectQualifies({ all: [{ field: 'priority', op: 'in', value: ['high', 'urgent'] }] }, attrs)).toBe(true);
    expect(subjectQualifies({ all: [{ field: 'priority', op: 'not_in', value: ['high'] }] }, attrs)).toBe(false);
    expect(subjectQualifies({ all: [{ field: 'score', op: 'gte', value: 50 }] }, attrs)).toBe(true);
    expect(subjectQualifies({ all: [{ field: 'score', op: 'lte', value: 50 }] }, attrs)).toBe(false);
    expect(subjectQualifies({ all: [{ field: 'owner', op: 'exists', value: null }] }, attrs)).toBe(true);
    expect(subjectQualifies({ all: [{ field: 'note', op: 'exists', value: null }] }, attrs)).toBe(false);
  });

  it('requires every clause, and fails closed on an unknown operator', () => {
    const attrs = { priority: 'high', score: 80 };
    expect(subjectQualifies({
      all: [
        { field: 'priority', op: 'eq', value: 'high' },
        { field: 'score', op: 'gte', value: 90 },
      ],
    }, attrs)).toBe(false);
    // An operator nobody can evaluate must not silently widen the policy.
    expect(subjectQualifies({ all: [{ field: 'score', op: 'approximately', value: 80 }] }, attrs)).toBe(false);
  });
});
