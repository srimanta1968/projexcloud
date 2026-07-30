/**
 * Escalation ladder and idempotent tick (P16 · EP-376 · PCF-03-3).
 *
 * The exactly-once property is a property of the DATABASE — a unique index plus a
 * trigger — so the tests that matter here need a real one. Opt in with SLA_IT=1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { createCalendar } from '../src/services/calendarService';
import { createPolicy, startClock, satisfyClock, type SlaPolicy } from '../src/services/clockService';
import {
  createRung,
  listRungs,
  setRungActive,
  runTick,
  listFirings,
  findAtRisk,
  registerRungAction,
  unregisterRungAction,
  registeredRungActions,
  resolveAudience,
  setOnCallResolver,
  setAudienceResolver,
  InvalidRungOffset,
  AudienceUnresolvable,
  type LadderRung,
  type RungActionContext,
} from '../src/services/ladderService';

const TENANT = 'c11c0000-0000-4000-8000-00000000abcd';
const RUN_IT = process.env.SLA_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

const ALWAYS_OPEN = {
  '1': [{ start: '00:00', end: '23:59' }], '2': [{ start: '00:00', end: '23:59' }],
  '3': [{ start: '00:00', end: '23:59' }], '4': [{ start: '00:00', end: '23:59' }],
  '5': [{ start: '00:00', end: '23:59' }], '6': [{ start: '00:00', end: '23:59' }],
  '7': [{ start: '00:00', end: '23:59' }],
};

/** A stub clock/rung pair for the pure audience tests. */
const stubClock = (owner: string | null) =>
  ({ clock_id: 'c1', tenant_id: TENANT, owner_ref: owner } as never);
const stubRung = (audience: Record<string, unknown>) =>
  ({ rung_id: 'r1', audience } as unknown as LadderRung);

describe('audience resolution (pure)', () => {
  afterEach(() => {
    setOnCallResolver(null);
    setAudienceResolver(null);
  });

  it('resolves the owner audience from the clock', async () => {
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'owner' }), stubClock('persona:1'), new Date().toISOString()),
    ).resolves.toEqual(['persona:1']);
  });

  it('refuses an owner audience on an unowned clock rather than paging nobody', async () => {
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'owner' }), stubClock(null), new Date().toISOString()),
    ).rejects.toBeInstanceOf(AudienceUnresolvable);
  });

  it('refuses an on_call audience when no roster is wired', async () => {
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'on_call' }), stubClock('p'), new Date().toISOString()),
    ).rejects.toMatchObject({ code: 'RUNG_AUDIENCE_UNRESOLVABLE' });
  });

  it('resolves on_call THROUGH the roster, at fire time', async () => {
    const seen: string[] = [];
    setOnCallResolver(async ({ at, rotation_ref }) => {
      seen.push(`${rotation_ref}@${at}`);
      return ['persona:oncall'];
    });
    const at = new Date().toISOString();
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'on_call', rotation_ref: 'tier-1' }), stubClock('p'), at),
    ).resolves.toEqual(['persona:oncall']);
    // The instant is passed through: who is on call now, not who was on call when
    // somebody wrote the policy.
    expect(seen).toEqual([`tier-1@${at}`]);
  });

  it('refuses when the roster returns nobody', async () => {
    setOnCallResolver(async () => []);
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'on_call' }), stubClock('p'), new Date().toISOString()),
    ).rejects.toBeInstanceOf(AudienceUnresolvable);
  });

  it('routes an unknown kind to the custom resolver, and refuses without one', async () => {
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'manager' }), stubClock('p'), new Date().toISOString()),
    ).rejects.toBeInstanceOf(AudienceUnresolvable);
    setAudienceResolver(async () => ['persona:manager']);
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'manager' }), stubClock('p'), new Date().toISOString()),
    ).resolves.toEqual(['persona:manager']);
  });

  it('takes a literal refs list, but not an empty one', async () => {
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'refs', refs: ['a', 'b'] }), stubClock(null), 'now'),
    ).resolves.toEqual(['a', 'b']);
    await expect(
      resolveAudience(TENANT, stubRung({ kind: 'refs', refs: [] }), stubClock(null), 'now'),
    ).rejects.toBeInstanceOf(AudienceUnresolvable);
  });
});

describe('action registry (pure)', () => {
  it('registers and unregisters handlers', () => {
    registerRungAction('test_action', async () => ({ ok: true }));
    expect(registeredRungActions()).toContain('test_action');
    unregisterRungAction('test_action');
    expect(registeredRungActions()).not.toContain('test_action');
  });
});

suite('escalation ladder and idempotent tick (integration)', () => {
  let calendarId = '';
  let policy: SlaPolicy;
  const stamp = Date.now();
  /** Every fire the handlers saw, in order — the duplicate detector. */
  let fired: RungActionContext[] = [];

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    const cal = await createCalendar({
      tenant_id: TENANT, slug: `ladder-open-${stamp}`, name: 'Always open',
      timezone: 'UTC', working_windows: ALWAYS_OPEN, weekend_rule: 'none',
    });
    calendarId = cal.calendar_id;
    policy = await createPolicy({
      tenant_id: TENANT, slug: `ladder-${stamp}`, name: 'Respond',
      subject_kind: 'request', duration_minutes: 120, calendar_id: calendarId,
      satisfaction_contract: {},
    });
    registerRungAction('notify', async (ctx) => {
      fired.push(ctx);
      return { delivered_to: ctx.audience.length };
    });
    registerRungAction('always_fails', async () => {
      throw new Error('provider unavailable');
    });
  });

  afterEach(() => {
    fired = [];
  });

  afterAll(async () => {
    unregisterRungAction('notify');
    unregisterRungAction('always_fails');
    setOnCallResolver(null);
    await dataService.query(
      `DELETE FROM sla.rung_firing WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.ladder_rung WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.sla_clock WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.sla_policy WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sla.business_calendar WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  /** A policy of its own per test, so rungs and firings never bleed across cases. */
  async function isolatedPolicy(slug: string): Promise<SlaPolicy> {
    return createPolicy({
      tenant_id: TENANT, slug: `${slug}-${stamp}`, name: slug,
      subject_kind: 'request', duration_minutes: 120, calendar_id: calendarId,
      satisfaction_contract: {},
    });
  }

  it('normalises minutes_before_due and minutes_after_due against the policy duration', async () => {
    const p = await isolatedPolicy('offsets');
    const before = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0,
      minutes_before_due: 30, action: 'notify',
    });
    const after = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 1,
      minutes_after_due: 15, action: 'notify', severity: 'urgent',
    });
    // 120-minute promise: 30 before due is 90 from the start, 15 after is 135.
    expect(before.offset_minutes).toBe(90);
    expect(after.offset_minutes).toBe(135);

    // Ambiguous or impossible configurations are refused at configuration time,
    // not silently coerced at fire time.
    await expect(createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 2,
      offset_minutes: 10, minutes_after_due: 10, action: 'notify',
    })).rejects.toBeInstanceOf(InvalidRungOffset);
    await expect(createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 3, action: 'notify',
    })).rejects.toBeInstanceOf(InvalidRungOffset);
    await expect(createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 4,
      minutes_before_due: 500, action: 'notify',
    })).rejects.toBeInstanceOf(InvalidRungOffset);
  });

  it('is DATA: a new ladder needs only rows, and severity/audience/hint ride along', async () => {
    const p = await isolatedPolicy('data-ladder');
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 60,
      action: 'notify', severity: 'info', label: 'nudge',
      audience: { kind: 'refs', refs: ['persona:a'] },
      remediation_hint: 'call the requester back',
    });
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 1, offset_minutes: 120,
      action: 'notify', severity: 'critical', audience: { kind: 'owner' },
    });
    const rungs = await listRungs({ tenant_id: TENANT, policy_id: p.policy_id });
    expect(rungs.map((r) => r.severity)).toEqual(['info', 'critical']);
    expect(rungs[0].remediation_hint).toBe('call the requester back');
    expect(rungs[0].audience).toEqual({ kind: 'refs', refs: ['persona:a'] });
  });

  it('fires only the rungs whose time has come, and skips deactivated ones', async () => {
    const p = await isolatedPolicy('due-only');
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 30,
      action: 'notify', audience: { kind: 'refs', refs: ['persona:a'] },
    });
    const later = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 1, offset_minutes: 600,
      action: 'notify', audience: { kind: 'refs', refs: ['persona:b'] },
    });
    const off = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 2, offset_minutes: 1,
      action: 'notify', audience: { kind: 'refs', refs: ['persona:c'] },
    });
    await setRungActive({ tenant_id: TENANT, rung_id: off.rung_id, is_active: false });

    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-due-only`,
      source_timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const result = await runTick({ tenant_id: TENANT });
    expect(result.rungs_fired).toBe(1);
    expect(fired.map((f) => f.audience[0])).toEqual(['persona:a']);
    const firings = await listFirings(TENANT, clock.clock_id);
    expect(firings).toHaveLength(1);
    expect(firings[0].state).toBe('fired');
    expect(firings[0].audience_snapshot).toEqual(['persona:a']);
    expect(firings[0].action_result).toEqual({ delivered_to: 1 });
    // The not-yet-due rung has no ledger row at all, and the deactivated one never will.
    expect(firings.some((f) => f.rung_id === later.rung_id)).toBe(false);
    expect(firings.some((f) => f.rung_id === off.rung_id)).toBe(false);
  });

  it('fires each rung EXACTLY ONCE under concurrent duplicate ticks', async () => {
    const p = await isolatedPolicy('concurrent');
    for (let i = 0; i < 3; i++) {
      await createRung({
        tenant_id: TENANT, policy_id: p.policy_id, rung_index: i, offset_minutes: 5 + i * 5,
        action: 'notify', audience: { kind: 'refs', refs: [`persona:${i}`] },
      });
    }
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-concurrent`,
      source_timestamp: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
    });

    // Six ticks at once — the situation a cron overlapping itself, two pods, and a
    // manual POST /api/sla/tick all produce.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runTick({ tenant_id: TENANT })),
    );

    const totalFired = results.reduce((n, r) => n + r.rungs_fired, 0);
    const totalSkipped = results.reduce((n, r) => n + r.rungs_skipped_duplicate, 0);
    expect(totalFired).toBe(3);            // three rungs, three fires, no more
    expect(totalSkipped).toBeGreaterThan(0); // the losers noticed and stood down
    // And the handler itself was invoked exactly three times.
    expect(fired.filter((f) => f.clock.clock_id === clock.clock_id)).toHaveLength(3);

    const firings = await listFirings(TENANT, clock.clock_id);
    expect(firings).toHaveLength(3);
    expect(firings.every((f) => f.state === 'fired')).toBe(true);
    expect(firings.every((f) => f.attempts === 1)).toBe(true);

    // A further tick fires nothing at all: every rung is spent.
    const again = await runTick({ tenant_id: TENANT });
    expect(again.rungs_fired).toBe(0);
  });

  it('retries a failed rung WITHOUT re-firing the ones that succeeded', async () => {
    const p = await isolatedPolicy('retry');
    const ok = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 5,
      action: 'notify', audience: { kind: 'refs', refs: ['persona:ok'] },
    });
    const bad = await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 1, offset_minutes: 6,
      action: 'always_fails', audience: { kind: 'refs', refs: ['persona:bad'] },
    });
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-retry`,
      source_timestamp: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });

    const first = await runTick({ tenant_id: TENANT });
    expect(first.rungs_fired).toBe(1);
    expect(first.rungs_failed).toBe(1);
    expect(first.errors[0].error).toMatch(/provider unavailable/);

    let firings = await listFirings(TENANT, clock.clock_id);
    const okRow = firings.find((f) => f.rung_id === ok.rung_id)!;
    const badRow = firings.find((f) => f.rung_id === bad.rung_id)!;
    expect(okRow.state).toBe('fired');
    expect(badRow.state).toBe('failed');
    expect(badRow.next_attempt_at).toBeTruthy();

    // Make the failed rung due for retry, then tick again.
    await dataService.query(
      `UPDATE sla.rung_firing SET next_attempt_at = now() - interval '1 minute' WHERE firing_id = $1`,
      [badRow.firing_id],
    );
    fired = [];
    const second = await runTick({ tenant_id: TENANT });
    expect(second.rungs_retried).toBe(1);
    // The successful rung was NOT touched — nobody gets paged twice because a
    // different rung's provider was down.
    expect(fired.filter((f) => f.rung.rung_id === ok.rung_id)).toHaveLength(0);

    firings = await listFirings(TENANT, clock.clock_id);
    const badAfter = firings.find((f) => f.rung_id === bad.rung_id)!;
    expect(badAfter.attempts).toBe(2);
    expect(badAfter.state).toBe('failed');
    expect(Date.parse(firings.find((f) => f.rung_id === ok.rung_id)!.fired_at as string))
      .toBe(Date.parse(okRow.fired_at as string));
  });

  it('fails a rung whose action has no handler instead of recording a silent success', async () => {
    const p = await isolatedPolicy('unhandled');
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 5,
      action: 'no_such_action', audience: { kind: 'refs', refs: ['persona:x'] },
    });
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-unhandled`,
      source_timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const result = await runTick({ tenant_id: TENANT });
    expect(result.rungs_failed).toBeGreaterThanOrEqual(1);
    const firing = (await listFirings(TENANT, clock.clock_id))[0];
    expect(firing.state).toBe('failed');
    expect(firing.last_error).toMatch(/RungActionUnhandled/);
  });

  it('does not escalate a paused clock, and stops escalating a satisfied one', async () => {
    const p = await isolatedPolicy('paused');
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 5,
      action: 'notify', audience: { kind: 'refs', refs: ['persona:p'] },
    });
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-paused`,
      source_timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    // Park it directly (the policy lists no pause conditions; the service would
    // rightly refuse, and what is under test here is the tick's scan).
    await dataService.query(
      `UPDATE sla.sla_clock SET state = 'paused', paused_at = now() WHERE clock_id = $1`,
      [clock.clock_id],
    );
    let result = await runTick({ tenant_id: TENANT });
    expect(result.rungs_fired).toBe(0);
    expect(await listFirings(TENANT, clock.clock_id)).toHaveLength(0);

    // Resumed, the overdue rung fires on the next tick — late, and visibly so.
    await dataService.query(
      `UPDATE sla.sla_clock SET state = 'running', paused_at = NULL WHERE clock_id = $1`,
      [clock.clock_id],
    );
    result = await runTick({ tenant_id: TENANT });
    expect(result.rungs_fired).toBe(1);
    const firing = (await listFirings(TENANT, clock.clock_id))[0];
    expect(Date.parse(firing.fired_at!)).toBeGreaterThan(Date.parse(firing.fire_at));

    // Satisfied: no further rung is ever claimed for it.
    await satisfyClock({ tenant_id: TENANT, clock_id: clock.clock_id, satisfied_by: 'persona:p' });
    const after = await runTick({ tenant_id: TENANT });
    expect(after.rungs_fired).toBe(0);
  });

  it('reports at-risk clocks with ladder progress and the next rung', async () => {
    const p = await isolatedPolicy('at-risk');
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 0, offset_minutes: 30,
      action: 'notify', severity: 'warning', audience: { kind: 'refs', refs: ['persona:a'] },
    });
    await createRung({
      tenant_id: TENANT, policy_id: p.policy_id, rung_index: 1, offset_minutes: 240,
      action: 'notify', severity: 'critical', audience: { kind: 'refs', refs: ['persona:b'] },
    });
    const { clock } = await startClock({
      tenant_id: TENANT, policy_id: p.policy_id, subject_ref: `s:${stamp}-at-risk`,
      source_timestamp: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      owner_ref: 'persona:owner',
    });
    await runTick({ tenant_id: TENANT });

    const atRisk = await findAtRisk({ tenant_id: TENANT, within_minutes: 120 });
    const mine = atRisk.find((r) => r.clock.clock_id === clock.clock_id)!;
    expect(mine).toBeTruthy();
    expect(mine.is_overdue).toBe(true);
    expect(mine.rungs_fired).toBe(1);
    expect(mine.highest_severity_fired).toBe('warning');
    // The critical rung has not fired yet, so it is what the queue should show next.
    expect(mine.next_rung?.severity).toBe('critical');
  });
});
