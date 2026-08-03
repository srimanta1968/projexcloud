/**
 * Breach recording and attainment reporting (P16 · EP-376 · PCF-03-4).
 *
 * Opt in with SLA_IT=1 — the mandatory reason code, the one-breach-per-clock rule
 * and the immutable cause are all enforced by the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { createCalendar } from '../src/services/calendarService';
import { createPolicy, startClock, satisfyClock, type SlaPolicy } from '../src/services/clockService';
import {
  runBreachScan,
  recordBreach,
  recordRecovery,
  listBreaches,
  listBreachReasons,
  upsertBreachReason,
  getAttainment,
  setIncidentOpener,
  openPendingSystemicIncidents,
  systemicGroupKey,
  BreachReasonRequired,
} from '../src/services/breachService';

const TENANT = 'c12c0000-0000-4000-8000-00000000abcd';
const RUN_IT = process.env.SLA_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

const ALWAYS_OPEN = {
  '1': [{ start: '00:00', end: '23:59' }], '2': [{ start: '00:00', end: '23:59' }],
  '3': [{ start: '00:00', end: '23:59' }], '4': [{ start: '00:00', end: '23:59' }],
  '5': [{ start: '00:00', end: '23:59' }], '6': [{ start: '00:00', end: '23:59' }],
  '7': [{ start: '00:00', end: '23:59' }],
};

describe('systemic grouping key (pure)', () => {
  it('groups by policy, cause and hour — "the same problem"', () => {
    const base = Date.parse('2026-07-29T10:15:00.000Z');
    const sameHour = Date.parse('2026-07-29T10:59:00.000Z');
    const nextHour = Date.parse('2026-07-29T11:01:00.000Z');
    expect(systemicGroupKey('p1', 'no_capacity', base))
      .toBe(systemicGroupKey('p1', 'no_capacity', sameHour));
    expect(systemicGroupKey('p1', 'no_capacity', base))
      .not.toBe(systemicGroupKey('p1', 'no_capacity', nextHour));
    expect(systemicGroupKey('p1', 'no_capacity', base))
      .not.toBe(systemicGroupKey('p1', 'other_cause', base));
    expect(systemicGroupKey('p1', 'no_capacity', base))
      .not.toBe(systemicGroupKey('p2', 'no_capacity', base));
  });
});

suite('breach recording and attainment (integration)', () => {
  let calendarId = '';
  let policy: SlaPolicy;
  const stamp = Date.now();

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    const cal = await createCalendar({
      tenant_id: TENANT, slug: `breach-open-${stamp}`, name: 'Always open',
      timezone: 'UTC', working_windows: ALWAYS_OPEN, weekend_rule: 'none',
    });
    calendarId = cal.calendar_id;
    policy = await createPolicy({
      tenant_id: TENANT, slug: `breach-${stamp}`, name: 'Respond',
      subject_kind: 'request', duration_minutes: 60, calendar_id: calendarId,
      satisfaction_contract: {},
    });
  });

  afterAll(async () => {
    setIncidentOpener(null);
    await dataService.query(`DELETE FROM sla.breach_record WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.systemic_incident WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.breach_reason WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.sla_clock WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.sla_policy WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.business_calendar WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  /** A clock whose deadline is already behind it. */
  async function overdueClock(suffix: string, hoursAgo = 4, owner = 'persona:owner') {
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: policy.policy_id, subject_ref: `s:${stamp}-${suffix}`,
      source_timestamp: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
      owner_ref: owner,
      metadata: { source_ref: 'web_form' },
    });
    return clock;
  }

  it('marks past-due clocks breached, idempotently, WITHOUT inventing a cause', async () => {
    const clock = await overdueClock('scan');
    const first = await runBreachScan({ tenant_id: TENANT });
    expect(first.clocks_marked).toBeGreaterThanOrEqual(1);
    expect(first.awaiting_cause).toBeGreaterThanOrEqual(1);

    const after = await dataService.one<{ state: string; breached_at: string }>(
      `SELECT state, breached_at FROM sla.sla_clock WHERE clock_id = $1`, [clock.clock_id]);
    expect(after!.state).toBe('breached');
    expect(after!.breached_at).toBeTruthy();
    // No record was fabricated: the deadline is a fact, the cause is not known.
    expect(await listBreaches({ tenant_id: TENANT, limit: 500 }))
      .not.toContainEqual(expect.objectContaining({ clock_id: clock.clock_id }));

    // A second scan marks nothing again.
    const second = await runBreachScan({ tenant_id: TENANT });
    expect(second.clocks_marked).toBe(0);
  });

  it('refuses to record a breach with no reason code', async () => {
    const clock = await overdueClock('noreason');
    await runBreachScan({ tenant_id: TENANT });
    await expect(
      recordBreach({ tenant_id: TENANT, clock_id: clock.clock_id, reason_code: '' }),
    ).rejects.toBeInstanceOf(BreachReasonRequired);
    await expect(
      recordBreach({ tenant_id: TENANT, clock_id: clock.clock_id, reason_code: '   ' }),
    ).rejects.toMatchObject({ status: 422, code: 'BREACH_REASON_REQUIRED' });
    expect(await listBreaches({ tenant_id: TENANT, limit: 500 }))
      .not.toContainEqual(expect.objectContaining({ clock_id: clock.clock_id }));
  });

  it('records a breach once per clock, with business-minute measures, and auto-registers the cause', async () => {
    const clock = await overdueClock('record');
    await runBreachScan({ tenant_id: TENANT });

    const first = await recordBreach({
      tenant_id: TENANT, clock_id: clock.clock_id,
      reason_code: 'awaiting_capacity', reason_detail: 'nobody available on the roster',
      recorded_by: 'persona:manager',
    });
    expect(first.created).toBe(true);
    // 4h-old signal on an always-open calendar with a 60-minute promise.
    expect(first.breach.elapsed_business_minutes).toBeGreaterThanOrEqual(230);
    expect(first.breach.overdue_business_minutes).toBeGreaterThanOrEqual(170);
    expect(first.breach.source_ref).toBe('web_form');
    expect(first.breach.recovery_action).toBeNull();

    // Idempotent: a retried call returns the same record rather than double-counting.
    const again = await recordBreach({
      tenant_id: TENANT, clock_id: clock.clock_id, reason_code: 'something_else',
    });
    expect(again.created).toBe(false);
    expect(again.breach.breach_id).toBe(first.breach.breach_id);
    expect(again.breach.reason_code).toBe('awaiting_capacity');

    const reasons = await listBreachReasons(TENANT);
    const auto = reasons.find((r) => r.code === 'awaiting_capacity')!;
    expect(auto.is_auto_registered).toBe(true);
    // Naming it deliberately clears the auto flag.
    await upsertBreachReason({
      tenant_id: TENANT, code: 'awaiting_capacity', label: 'Awaiting capacity', category: 'capacity',
    });
    const named = (await listBreachReasons(TENANT)).find((r) => r.code === 'awaiting_capacity')!;
    expect(named.is_auto_registered).toBe(false);
    expect(named.category).toBe('capacity');
  });

  it('records the recovery afterwards, and the cause stays as recorded', async () => {
    const clock = await overdueClock('recovery');
    await runBreachScan({ tenant_id: TENANT });
    const { breach } = await recordBreach({
      tenant_id: TENANT, clock_id: clock.clock_id, reason_code: 'missed_handoff',
    });
    const recovered = await recordRecovery({
      tenant_id: TENANT, breach_id: breach.breach_id,
      recovery_action: 'reassigned to the backup and answered', recovered_by: 'persona:backup',
    });
    expect(recovered.recovery_action).toMatch(/backup/);
    expect(recovered.recovered_at).toBeTruthy();
    expect(recovered.reason_code).toBe('missed_handoff');

    // The database refuses a rewritten cause even by direct UPDATE.
    let blocked = false;
    try {
      await dataService.query(
        `UPDATE sla.breach_record SET reason_code = 'someone_elses_fault' WHERE breach_id = $1`,
        [breach.breach_id],
      );
    } catch { blocked = true; }
    expect(blocked).toBe(true);
  });

  it('opens exactly ONE incident for a systemic group, however many breaches join it', async () => {
    const opened: string[] = [];
    setIncidentOpener(async ({ group_key, breach_count }) => {
      opened.push(`${group_key}#${breach_count}`);
      return { incident_ref: `incident-${opened.length}` };
    });

    const clocks = await Promise.all([
      overdueClock('sys-a'), overdueClock('sys-b'), overdueClock('sys-c'),
    ]);
    await runBreachScan({ tenant_id: TENANT });

    const groupKey = `shared-group-${stamp}`;
    const results = [];
    for (const clock of clocks) {
      results.push(await recordBreach({
        tenant_id: TENANT, clock_id: clock.clock_id,
        reason_code: 'upstream_outage', is_systemic: true, systemic_group_key: groupKey,
      }));
    }

    // Three breaches, one group, ONE incident — not one per breach and not one per rung.
    expect(results.filter((r) => r.incident_opened)).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(results.every((r) => r.systemic?.group_key === groupKey)).toBe(true);
    const group = results[results.length - 1].systemic!;
    expect(group.breach_count).toBe(3);
    expect(group.incident_ref).toBe('incident-1');
    setIncidentOpener(null);
  });

  it('still records the breach when no incident opener is wired, and opens it later', async () => {
    setIncidentOpener(null);
    const clock = await overdueClock('sys-pending');
    await runBreachScan({ tenant_id: TENANT });
    const groupKey = `pending-group-${stamp}`;
    const { breach, systemic, incident_opened } = await recordBreach({
      tenant_id: TENANT, clock_id: clock.clock_id,
      reason_code: 'provider_down', is_systemic: true, systemic_group_key: groupKey,
    });
    // The breach survives the missing integration; only the escalation is pending.
    expect(breach.breach_id).toBeTruthy();
    expect(incident_opened).toBe(false);
    expect(systemic?.incident_ref).toBeNull();
    expect(systemic?.incident_error).toMatch(/no incident opener/);

    setIncidentOpener(async () => ({ incident_ref: 'incident-late' }));
    const retried = await openPendingSystemicIncidents({ tenant_id: TENANT });
    expect(retried.opened).toBeGreaterThanOrEqual(1);
    const group = await dataService.one<{ incident_ref: string; incident_error: string | null }>(
      `SELECT incident_ref, incident_error FROM sla.systemic_incident WHERE tenant_id = $1 AND group_key = $2`,
      [TENANT, groupKey],
    );
    expect(group!.incident_ref).toBe('incident-late');
    expect(group!.incident_error).toBeNull();
    setIncidentOpener(null);
  });

  it('reports attainment over BUSINESS minutes with cause and recovery for every miss', async () => {
    // A dedicated policy so this window contains only this test's clocks.
    const p = await createPolicy({
      tenant_id: TENANT, slug: `attain-${stamp}`, name: 'Attainment',
      subject_kind: 'request', duration_minutes: 60, calendar_id: calendarId,
      satisfaction_contract: {},
    });
    const from = new Date(Date.now() - 60_000).toISOString();

    // Two kept promises, closed well inside the hour.
    for (const n of [1, 2]) {
      const { clock } = await startClock({
        tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-ok-${n}`,
        source_timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        owner_ref: 'persona:fast', metadata: { source_ref: 'phone' },
      });
      await satisfyClock({ tenant_id: TENANT, clock_id: clock.clock_id, satisfied_by: 'persona:fast' });
    }
    // Two misses: one explained and recovered, one with no cause recorded at all.
    const explained = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-miss-1`,
      source_timestamp: new Date(Date.now() - 5 * 3600_000).toISOString(),
      owner_ref: 'persona:slow', metadata: { source_ref: 'web_form' },
    });
    const silent = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-miss-2`,
      source_timestamp: new Date(Date.now() - 6 * 3600_000).toISOString(),
      owner_ref: 'persona:slow', metadata: { source_ref: 'web_form' },
    });
    await runBreachScan({ tenant_id: TENANT });
    const { breach } = await recordBreach({
      tenant_id: TENANT, clock_id: explained.clock.clock_id, reason_code: 'no_capacity',
      reason_detail: 'roster gap at 02:00',
    });
    await recordRecovery({
      tenant_id: TENANT, breach_id: breach.breach_id,
      recovery_action: 'backup answered next morning', recovered_by: 'persona:backup',
    });

    const report = await getAttainment({
      tenant_id: TENANT, policy_id: p.policy_id,
      from, to: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(report.total).toBe(4);
    expect(report.attained).toBe(2);
    expect(report.breached).toBe(2);
    expect(report.attainment_pct).toBe(50);
    expect(report.truncated).toBe(false);

    // Percentiles are business minutes: the two kept clocks are ~10 minutes, the
    // misses hours — so the median sits low and P95 high.
    expect(report.median_business_minutes).not.toBeNull();
    expect(report.p95_business_minutes!).toBeGreaterThan(report.median_business_minutes!);
    expect(report.median_business_minutes!).toBeLessThan(200);
    expect(report.p95_business_minutes!).toBeGreaterThan(200);

    // Every miss carries cause and recovery — and the one nobody explained is
    // COUNTED AND NAMED rather than dropped.
    expect(report.misses).toHaveLength(2);
    const withCause = report.misses.find((m) => m.clock_id === explained.clock.clock_id)!;
    expect(withCause.reason_code).toBe('no_capacity');
    expect(withCause.reason_detail).toBe('roster gap at 02:00');
    expect(withCause.recovery_action).toMatch(/backup answered/);
    expect(withCause.recovered_by).toBe('persona:backup');
    const noCause = report.misses.find((m) => m.clock_id === silent.clock.clock_id)!;
    expect(noCause.reason_code).toBeNull();
    expect(report.misses_without_cause).toBe(1);

    // Breakdowns by every requested dimension.
    const byOwner = report.breakdowns.owner;
    expect(byOwner.find((b) => b.key === 'persona:fast')!.attainment_pct).toBe(100);
    expect(byOwner.find((b) => b.key === 'persona:slow')!.attainment_pct).toBe(0);
    const bySource = report.breakdowns.source;
    expect(bySource.find((b) => b.key === 'phone')!.attained).toBe(2);
    expect(bySource.find((b) => b.key === 'web_form')!.breached).toBe(2);
    expect(report.breakdowns.reason.map((b) => b.key).sort())
      .toEqual(['attained', 'cause_not_recorded', 'no_capacity']);
    expect(report.breakdowns.day).toHaveLength(1);
    expect(report.breakdowns.hour.length).toBeGreaterThanOrEqual(1);
    // A breakdown bucket carries its own misses, so a report can be read one row
    // at a time without going back to the source.
    expect(bySource.find((b) => b.key === 'web_form')!.misses).toHaveLength(2);
  });

  it('lets a BREACHED clock still be satisfied — late, and still counted as a miss', async () => {
    // The common case, not an edge one: the deadline passes and somebody answers
    // anyway. Refusing this would leave the clock breached forever with no
    // satisfied_at, so nothing could record when the late response happened and a
    // report could not tell a miss that was answered from one that was abandoned.
    const p = await createPolicy({
      tenant_id: TENANT, slug: `late-answer-${stamp}`, name: 'Late answer',
      subject_kind: 'request', duration_minutes: 60, calendar_id: calendarId,
      satisfaction_contract: {},
    });
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-late`,
      source_timestamp: new Date(Date.now() - 5 * 3600_000).toISOString(),
      owner_ref: 'persona:late', metadata: { source_ref: 'phone' },
    });
    await runBreachScan({ tenant_id: TENANT });
    expect((await dataService.one<{ state: string }>(
      `SELECT state FROM sla.sla_clock WHERE clock_id = $1`, [clock.clock_id]))!.state)
      .toBe('breached');

    const { breach } = await recordBreach({
      tenant_id: TENANT, clock_id: clock.clock_id, reason_code: 'no_capacity',
    });

    const satisfied = await satisfyClock({
      tenant_id: TENANT, clock_id: clock.clock_id, satisfied_by: 'persona:late',
    });
    expect(satisfied.state).toBe('satisfied');
    expect(satisfied.satisfied_at).toBeTruthy();
    // Late, so still a miss: satisfied_at is after due_at.
    expect(Date.parse(satisfied.satisfied_at as unknown as string))
      .toBeGreaterThan(Date.parse(satisfied.due_at as unknown as string));

    const report = await getAttainment({
      tenant_id: TENANT, policy_id: p.policy_id,
      from: new Date(Date.now() - 86400_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    // Nothing is laundered by allowing the late close: the clock still counts as
    // breached and its cause is still attached.
    expect(report.attained).toBe(0);
    expect(report.breached).toBe(1);
    expect(report.misses[0].reason_code).toBe('no_capacity');
    expect(breach.reason_code).toBe('no_capacity');
  });

  it('says so when the clock ceiling truncates the sample', async () => {
    const report = await getAttainment({
      tenant_id: TENANT, from: new Date(0).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(), max_clocks: 1,
    });
    expect(report.truncated).toBe(true);
    expect(report.clocks_considered).toBe(1);
  });
});
