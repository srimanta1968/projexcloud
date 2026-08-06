/**
 * Overdue queue and date-push governance (P16 · EP-380 · PCF-07-2).
 *
 *   CRM_IT=1 DATABASE_URL=... pnpm --filter @projexlight/sdk-crm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { setSubjectNextAction } from '../src/services/subjectNextActionService';
import {
  DueDateUnchanged, getOverduePolicy, getPushLog, getSubjectPushSummary, levelFor, listOverdue,
  ManagerReasonRequired, NextActionNotFound, ReasonRequired, reschedule,
  upsertOverduePolicy,
} from '../src/services/overdueService';

const RUN = process.env.CRM_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = randomUUID();
const OWNER = randomUUID();

const commit = (subject_ref: string, due: Date) => ({
  tenant_id: TENANT, subject_ref, action_type: 'call', owner_persona_id: OWNER,
  due_at: due, purpose: 'chase the signature',
  intended_outcome: 'they return the signed order form',
});

describe('escalation ladder (pure)', () => {
  const offsets = [
    { minutes: 60, level: 'nudge' },
    { minutes: 1440, level: 'manager' },
    { minutes: 10080, level: 'director' },
  ];

  it('reports the HIGHEST level passed, not the first', () => {
    // An action a week overdue is at the director level; calling it 'nudge' because
    // that offset was crossed first buries it under everything an hour late.
    expect(levelFor(30, offsets)).toBeNull();
    expect(levelFor(120, offsets)).toBe('nudge');
    expect(levelFor(2000, offsets)).toBe('manager');
    expect(levelFor(20000, offsets)).toBe('director');
  });

  it('handles an unsorted ladder and an empty one', () => {
    expect(levelFor(2000, [...offsets].reverse())).toBe('manager');
    expect(levelFor(2000, [])).toBeNull();
  });
});

suite('overdue queue and push governance', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    await upsertOverduePolicy({
      tenant_id: TENANT,
      // Deliberately out of order: the service sorts, because a ladder that fires
      // 'manager' before 'nudge' reads as a system nobody configured.
      offsets: [{ minutes: 1440, level: 'manager' }, { minutes: 60, level: 'nudge' }],
      push_threshold: 2,
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    await dataService.query(`DELETE FROM crm.next_action WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM crm.overdue_policy WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  it('stores escalation offsets as tenant configuration, sorted', async () => {
    const policy = await getOverduePolicy(TENANT, 'lead');
    // "Overdue by a day" means something different for a ticket and a renewal, so the
    // ladder is config rather than a constant somebody typed into a service.
    expect(policy?.offsets).toEqual([
      { minutes: 60, level: 'nudge' }, { minutes: 1440, level: 'manager' },
    ]);
    expect(policy?.push_threshold).toBe(2);
  });

  it('lists overdue actions with how late they are and which level they have reached', async () => {
    await setSubjectNextAction(commit('lead:late-2h', new Date(Date.now() - 2 * 3600_000)));
    await setSubjectNextAction(commit('lead:late-3d', new Date(Date.now() - 3 * 86_400_000)));
    await setSubjectNextAction(commit('lead:not-due', new Date(Date.now() + 86_400_000)));

    const queue = await listOverdue({ tenant_id: TENANT });
    const refs = queue.entries.map((e) => e.subject_ref);
    expect(refs).toContain('lead:late-2h');
    expect(refs).toContain('lead:late-3d');
    // Not yet due is not overdue.
    expect(refs).not.toContain('lead:not-due');

    const twoHours = queue.entries.find((e) => e.subject_ref === 'lead:late-2h')!;
    const threeDays = queue.entries.find((e) => e.subject_ref === 'lead:late-3d')!;
    expect(twoHours.escalation_level).toBe('nudge');
    expect(threeDays.escalation_level).toBe('manager');
    expect(threeDays.minutes_overdue).toBeGreaterThan(twoHours.minutes_overdue);
    // The ladder comes back with the queue so a caller renders it rather than guessing.
    expect(queue.offsets).toHaveLength(2);
  });

  it('filters by owner and by subject kind', async () => {
    const mine = await listOverdue({ tenant_id: TENANT, owner_persona_id: OWNER });
    expect(mine.entries.length).toBeGreaterThan(0);
    const other = await listOverdue({ tenant_id: TENANT, owner_persona_id: randomUUID() });
    expect(other.entries).toHaveLength(0);
    const tickets = await listOverdue({ tenant_id: TENANT, subject_kind: 'ticket' });
    expect(tickets.entries).toHaveLength(0);
  });

  it('refuses to move a due date without a reason', async () => {
    const action = await setSubjectNextAction(
      commit('lead:push-1', new Date(Date.now() - 3600_000)));
    await expect(reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 86_400_000), reason: '   ',
    })).rejects.toBeInstanceOf(ReasonRequired);
    // Nothing moved, and nothing was logged.
    expect(await getPushLog({ tenant_id: TENANT, next_action_id: action.next_action_id }))
      .toEqual([]);
  });

  it('logs every move with its reason and counts them', async () => {
    const action = await setSubjectNextAction(
      commit('lead:push-2', new Date(Date.now() - 3600_000)));
    const first = await reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 86_400_000),
      reason: 'they asked for a week', pushed_by: 'rep-1',
    });
    expect(first.push_count).toBe(1);
    const second = await reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 2 * 86_400_000),
      reason: 'legal review still running', pushed_by: 'rep-1',
    });
    expect(second.push_count).toBe(2);

    const log = await getPushLog({ tenant_id: TENANT, next_action_id: action.next_action_id });
    expect(log.map((p) => p.seq)).toEqual([1, 2]);
    expect(log.map((p) => p.reason))
      .toEqual(['they asked for a week', 'legal review still running']);

    // The FIRST commitment is frozen, so the total slip is answerable — which the count
    // on its own cannot say.
    expect(second.original_due_at).toBe(first.original_due_at);
    expect(second.total_slip_minutes).toBeGreaterThan(first.total_slip_minutes as number);
  });

  it('requires a manager once the push threshold is reached', async () => {
    const action = await setSubjectNextAction(
      commit('lead:push-3', new Date(Date.now() - 3600_000)));
    for (const reason of ['first slip', 'second slip']) {
      await reschedule({
        tenant_id: TENANT, next_action_id: action.next_action_id,
        new_due_at: new Date(Date.now() + Math.random() * 1e6 + 86_400_000), reason,
      });
    }
    // A ceiling that only warns is not a ceiling.
    await expect(reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 5 * 86_400_000), reason: 'one more week',
    })).rejects.toBeInstanceOf(ManagerReasonRequired);

    const authorised = await reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 5 * 86_400_000),
      reason: 'one more week', approved_by: 'manager-1',
    });
    expect(authorised.push_count).toBe(3);
    const log = await getPushLog({ tenant_id: TENANT, next_action_id: action.next_action_id });
    expect(log.at(-1)?.approved_by).toBe('manager-1');
  });

  it('counts pushes per SUBJECT, so replacing the action does not reset the pattern', async () => {
    const subject_ref = 'lead:push-4';
    const first = await setSubjectNextAction(commit(subject_ref, new Date(Date.now() - 3600_000)));
    await reschedule({
      tenant_id: TENANT, next_action_id: first.next_action_id,
      new_due_at: new Date(Date.now() + 86_400_000), reason: 'slip one',
    });
    // A new action supersedes the old one and starts its own counter at zero…
    const second = await setSubjectNextAction(commit(subject_ref, new Date(Date.now() - 3600_000)));
    await reschedule({
      tenant_id: TENANT, next_action_id: second.next_action_id,
      new_due_at: new Date(Date.now() + 2 * 86_400_000), reason: 'slip two',
    });

    const summary = await getSubjectPushSummary(TENANT, subject_ref);
    // …but the SUBJECT has been pushed twice, which is the pattern that matters. Per
    // action alone, a subject could slip indefinitely and every count would read as one.
    expect(summary.push_count).toBe(2);
    expect(summary.distinct_actions_pushed).toBe(2);
    expect(summary.last_reason).toBe('slip two');
  });

  it('refuses a push that moves nothing, and one on an action that is not open', async () => {
    const action = await setSubjectNextAction(
      commit('lead:push-5', new Date(Date.now() - 3600_000)));
    const same = await dataService.one<{ due_at: Date }>(
      `SELECT due_at FROM crm.next_action WHERE next_action_id = $1`, [action.next_action_id]);
    // A reason IS supplied here, so this is NOT the missing-reason path — that one is
    // asserted separately above with a blank reason. What this asserts is the no-op: a
    // push that moves the date nowhere is not a push, and logging it would inflate the
    // count that managers read as a slipping pattern.
    await expect(reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(same!.due_at), reason: 'no change',
    })).rejects.toBeInstanceOf(DueDateUnchanged);

    await expect(reschedule({
      tenant_id: TENANT, next_action_id: randomUUID(),
      new_due_at: new Date(), reason: 'ghost',
    })).rejects.toBeInstanceOf(NextActionNotFound);
  });

  it('keeps the push log un-rewritable and the original date frozen', async () => {
    const action = await setSubjectNextAction(
      commit('lead:push-6', new Date(Date.now() - 3600_000)));
    await reschedule({
      tenant_id: TENANT, next_action_id: action.next_action_id,
      new_due_at: new Date(Date.now() + 86_400_000), reason: 'genuine reason',
    });

    let edited = '';
    try {
      await dataService.query(
        `UPDATE crm.date_push_log SET reason = 'tidied up' WHERE next_action_id = $1`,
        [action.next_action_id]);
    } catch (err) { edited = (err as Error).message; }
    // A push log whose reasons can be tidied afterwards is worth nothing.
    expect(edited).toMatch(/cannot be rewritten/);

    let moved = '';
    try {
      await dataService.query(
        `UPDATE crm.next_action SET original_due_at = now() WHERE next_action_id = $1`,
        [action.next_action_id]);
    } catch (err) { moved = (err as Error).message; }
    expect(moved).toMatch(/cannot be moved/);
  });
});
