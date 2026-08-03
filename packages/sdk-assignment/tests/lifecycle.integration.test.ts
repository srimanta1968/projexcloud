/**
 * Assignment lifecycle and the source-timestamp invariant (P16 · EP-379 · PCF-06-2).
 *
 *   ASSIGNMENT_IT=1 DATABASE_URL=... pnpm --filter @projexlight/sdk-assignment test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import {
  accept, complete, decline, getAssignment, getHistory, NoBackupDesignated, offer,
  reassign, ReasonRequired, setClockStarter, sweepExpiredOffers, InvalidTransition,
} from '../src/services/lifecycleService';

const RUN = process.env.ASSIGNMENT_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
const CARLA = randomUUID();
const MANAGER = randomUUID();
/** Six hours ago: the subject has been waiting since long before any of this. */
const SOURCE = new Date(Date.now() - 6 * 3600_000);

suite('assignment lifecycle', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
  });

  afterEach(() => setClockStarter(null));

  afterAll(async () => {
    if (!RUN) return;
    setClockStarter(null);
    await dataService.query(`DELETE FROM assignment.assignment_record WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  const fresh = (over: Partial<Parameters<typeof offer>[0]> = {}) => offer({
    tenant_id: TENANT, subject_ref: `subj-${randomUUID()}`, source_timestamp: SOURCE,
    primary_persona_id: ALICE, backup_persona_id: BOB, manager_persona_id: MANAGER,
    acceptance_window_minutes: 5, actor: 'qa', ...over,
  });

  it('keeps the source timestamp across EVERY transfer', async () => {
    const record = await fresh();
    expect(new Date(record.source_timestamp).getTime()).toBe(SOURCE.getTime());

    const declined = await decline({
      tenant_id: TENANT, record_id: record.record_id, reason: 'wrong specialty', actor: 'alice',
    });
    const reassigned = await reassign({
      tenant_id: TENANT, record_id: record.record_id, to_persona_id: CARLA,
      reason: 'territory change', actor: 'manager',
    });
    const accepted = await accept({ tenant_id: TENANT, record_id: record.record_id });
    const done = await complete({ tenant_id: TENANT, record_id: record.record_id });

    for (const [label, state] of [
      ['decline', declined], ['reassign', reassigned], ['accept', accepted], ['complete', done],
    ] as const) {
      // Each transfer moves OWNERSHIP. If it moved the clock, a subject waiting six
      // hours would read as fresh and the breach report would say all is well.
      expect(new Date(state.source_timestamp).getTime(), `${label} moved the source timestamp`)
        .toBe(SOURCE.getTime());
      expect(state.original_persona_id, `${label} rewrote the original owner`).toBe(ALICE);
    }
  });

  it('refuses to move the source timestamp even by direct UPDATE', async () => {
    const record = await fresh();
    let message = '';
    try {
      await dataService.query(
        `UPDATE assignment.assignment_record SET source_timestamp = now() WHERE record_id = $1`,
        [record.record_id],
      );
    } catch (err) { message = (err as Error).message; }
    // Enforced in the database, not left to six services to remember.
    expect(message).toMatch(/never moves/);
  });

  it('requires a reason to decline, and routes immediately to the backup', async () => {
    const record = await fresh();
    await expect(decline({
      tenant_id: TENANT, record_id: record.record_id, reason: '   ',
    })).rejects.toBeInstanceOf(ReasonRequired);

    const after = await decline({
      tenant_id: TENANT, record_id: record.record_id, reason: 'out of area', actor: 'alice',
    });
    // Immediately: waiting for the next sweep would spend the acceptance window twice,
    // once on somebody who has already said no.
    expect(after.primary_persona_id).toBe(BOB);
    expect(after.state).toBe('OFFERED');

    const history = await getHistory(TENANT, record.record_id);
    const declined = history.find((h) => h.transition === 'DECLINED');
    expect(declined?.from_persona_id).toBe(ALICE);
    expect(declined?.to_persona_id).toBe(BOB);
    expect(declined?.reason).toBe('out of area');
  });

  it('refuses a decline with nobody to fall to rather than leaving it unowned', async () => {
    const record = await fresh({ backup_persona_id: undefined });
    await expect(decline({
      tenant_id: TENANT, record_id: record.record_id, reason: 'not mine',
    })).rejects.toBeInstanceOf(NoBackupDesignated);
    // Still owned by somebody — an assignment nobody owns is invisible.
    expect((await getAssignment(TENANT, record.record_id))?.primary_persona_id).toBe(ALICE);
  });

  it('falls back automatically when the acceptance window expires', async () => {
    const record = await fresh({ acceptance_window_minutes: 5 });
    const early = await sweepExpiredOffers({ tenant_id: TENANT, now: new Date(Date.now() + 60_000) });
    expect(early.fell_back.find((f) => f.record_id === record.record_id)).toBeUndefined();

    const late = await sweepExpiredOffers({
      tenant_id: TENANT, now: new Date(Date.now() + 6 * 60_000),
    });
    const moved = late.fell_back.find((f) => f.record_id === record.record_id);
    expect(moved?.from_persona_id).toBe(ALICE);
    expect(moved?.to_persona_id).toBe(BOB);
    const history = await getHistory(TENANT, record.record_id);
    const fell = history.find((h) => h.transition === 'FELL_BACK');
    // No reason on a system fallback: a reason is demanded of people, who had a choice.
    expect(fell?.reason).toBeNull();
    expect(fell?.actor).toBe('system:acceptance-window');
  });

  it('reports a stranded offer instead of silently skipping it', async () => {
    const record = await fresh({ backup_persona_id: undefined, acceptance_window_minutes: 1 });
    const swept = await sweepExpiredOffers({
      tenant_id: TENANT, now: new Date(Date.now() + 2 * 60_000),
    });
    // The case that most needs attention: an expired window with nobody to catch it.
    expect(swept.stranded.some((s) => s.record_id === record.record_id)).toBe(true);
  });

  it('records every prior owner and reason, append-only', async () => {
    const record = await fresh();
    await decline({ tenant_id: TENANT, record_id: record.record_id, reason: 'wrong skill', actor: 'alice' });
    await reassign({
      tenant_id: TENANT, record_id: record.record_id, to_persona_id: CARLA,
      reason: 'load balancing', actor: 'manager',
    });
    await accept({ tenant_id: TENANT, record_id: record.record_id });

    const history = await getHistory(TENANT, record.record_id);
    expect(history.map((h) => h.transition)).toEqual(['OFFERED', 'DECLINED', 'REASSIGNED', 'ACCEPTED']);
    expect(history.map((h) => h.seq)).toEqual([1, 2, 3, 4]);
    // "It bounced three times" tells an operator nothing; the reasons tell them the
    // routing rules are wrong.
    expect(history.filter((h) => h.reason).map((h) => h.reason))
      .toEqual(['wrong skill', 'load balancing']);

    // An entry cannot be REWRITTEN — that would change what happened.
    let message = '';
    try {
      await dataService.query(
        `UPDATE assignment.assignment_history SET reason = 'rewritten' WHERE record_id = $1`,
        [record.record_id],
      );
    } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/cannot be rewritten/);

    // But it CAN be removed with the assignment it describes. Migration 004 refused
    // both and made an assignment undeletable the moment it had any history, which
    // would have blocked every retention policy and erasure request.
    const throwaway = await fresh();
    await dataService.query(
      `DELETE FROM assignment.assignment_record WHERE record_id = $1`, [throwaway.record_id],
    );
    expect(await getHistory(TENANT, throwaway.record_id)).toEqual([]);
  });

  it('starts SLA clocks FROM THE SOURCE TIMESTAMP, never from the transfer', async () => {
    const seen: Array<{ kind: string; from: string }> = [];
    setClockStarter(async (req) => {
      seen.push({ kind: req.kind, from: req.source_timestamp });
      return { clock_ref: `clk-${req.kind}-${seen.length}` };
    });

    const record = await fresh();
    expect(record.acceptance_clock_ref).toMatch(/^clk-acceptance/);
    expect(record.response_clock_ref).toMatch(/^clk-response/);

    await decline({ tenant_id: TENANT, record_id: record.record_id, reason: 'nope' });
    // The tempting bug: starting the response clock at the transfer, which quietly
    // gives every bounce a fresh SLA.
    for (const clock of seen) {
      expect(new Date(clock.from).getTime()).toBe(SOURCE.getTime());
    }
    // A new acceptance window for the backup; the response clock is NOT restarted.
    expect(seen.filter((c) => c.kind === 'response')).toHaveLength(1);
    expect(seen.filter((c) => c.kind === 'acceptance')).toHaveLength(2);
  });

  it('keeps the assignment when a clock cannot be started', async () => {
    setClockStarter(async () => { throw new Error('sla unreachable'); });
    const record = await fresh();
    // A ref that is null is visibly different from one that is running; losing the
    // assignment because timing was down would be worse.
    expect(record.record_id).toBeTruthy();
    expect(record.acceptance_clock_ref).toBeNull();
  });

  it('is idempotent on accept and refuses transitions from a closed state', async () => {
    const record = await fresh();
    const first = await accept({ tenant_id: TENANT, record_id: record.record_id });
    const second = await accept({ tenant_id: TENANT, record_id: record.record_id });
    // Compared as instants: node-pg hands back Date objects, and two equal Dates are
    // not the same object — toBe would fail on a correct result.
    expect(new Date(second.accepted_at as string).getTime())
      .toBe(new Date(first.accepted_at as string).getTime());

    await complete({ tenant_id: TENANT, record_id: record.record_id });
    await expect(reassign({
      tenant_id: TENANT, record_id: record.record_id, to_persona_id: CARLA, reason: 'too late',
    })).rejects.toBeInstanceOf(InvalidTransition);
  });
});
