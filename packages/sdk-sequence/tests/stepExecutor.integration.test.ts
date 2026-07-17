/**
 * Integration tests for the sdk-sequence step executor against a live Postgres.
 *
 * Opt-in: set SEQUENCE_IT=1 and provide a connection (DATABASE_URL or the
 * standard PG* env vars) pointing at a DB with the sequence schema applied.
 * The suite skips otherwise so it never blocks environments without a DB.
 *
 * Covers the executor acceptance scenarios end-to-end:
 *   - a due step inside the send-window is sent and the next step is enqueued;
 *   - re-running the tick does NOT re-send or double-enqueue (idempotent);
 *   - a step whose sequence is fully quiet is deferred, not sent;
 *   - a failing send is retried (attempt_count grows, status returns to pending).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initPool, closeAllPools, dataService } from '@projexlight/db-runtime';
import {
  runSequenceTick,
  setSequenceStepSender,
  _resetSequenceStepSender,
  type ExecutableStep,
} from '../src/services/stepExecutor';
import { upsertGuardConfig } from '../src/services/guardEngine';

const RUN = process.env.SEQUENCE_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = 'f1f1f1f1-0000-4000-8000-0000000000aa';

let sendCount = 0;
let forceFail = false;
const sentSteps: ExecutableStep[] = [];

async function seedSequence(metadata: Record<string, unknown>): Promise<{ sequence_id: string }> {
  const seq = await dataService.one<{ sequence_id: string }>(
    `INSERT INTO sequence.sequence (tenant_id, name, metadata)
     VALUES ($1, 'IT seq', $2::jsonb) RETURNING sequence_id`,
    [TENANT, JSON.stringify(metadata)],
  );
  await dataService.query(
    `INSERT INTO sequence.step (tenant_id, sequence_id, step_number, channel, action, delay_seconds)
     VALUES ($1,$2,1,'email','send',0),($1,$2,2,'email','send',0)`,
    [TENANT, seq!.sequence_id],
  );
  return seq!;
}

async function seedDueStep(sequence_id: string, enrollment_id: string): Promise<void> {
  await dataService.query(
    `INSERT INTO sequence.execution_step
       (tenant_id, enrollment_id, sequence_id, step_number, subject_persona_id,
        channel, action, status, next_run_at, dedupe_key)
     VALUES ($1,$2,$3,1, gen_random_uuid(), 'email','send','pending', now(), $4)`,
    [TENANT, enrollment_id, sequence_id, `${enrollment_id}:1`],
  );
}

async function cleanup(): Promise<void> {
  await dataService.query(`DELETE FROM sequence.execution_step WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.step WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.sequence WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.guard_log WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.circuit_breaker WHERE tenant_id = $1`, [TENANT]);
}

suite('sdk-sequence step executor (integration)', () => {
  beforeAll(async () => {
    initPool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
    // Isolate executor behavior (send / defer / retry) from the frequency guards:
    // permissive config so cooldown/max-message caps never interfere here. The
    // guards themselves are covered by guardEngine.integration.test.ts.
    await upsertGuardConfig(TENANT, { cooldown_seconds: 0, max_messages: 1_000_000 });
    setSequenceStepSender(async (step) => {
      sendCount++;
      sentSteps.push(step);
      return forceFail ? { delivered: false, error: 'boom' } : { delivered: true, provider_message_id: 'm1' };
    });
  });

  afterAll(async () => {
    _resetSequenceStepSender();
    await cleanup();
    await closeAllPools();
  });

  beforeEach(async () => {
    sendCount = 0;
    forceFail = false;
    sentSteps.length = 0;
    await cleanup();
  });

  it('sends a due in-window step and enqueues the next step', async () => {
    const seq = await seedSequence({});
    const enrollment = 'aaaaaaa1-0000-4000-8000-000000000001';
    await seedDueStep(seq.sequence_id, enrollment);

    const r = await runSequenceTick(50);
    expect(r.sent).toBe(1);
    expect(sendCount).toBe(1);

    const step1 = await dataService.one<{ status: string }>(
      `SELECT status FROM sequence.execution_step WHERE dedupe_key = $1`, [`${enrollment}:1`]);
    expect(step1!.status).toBe('sent');
    const step2 = await dataService.one<{ status: string }>(
      `SELECT status FROM sequence.execution_step WHERE dedupe_key = $1`, [`${enrollment}:2`]);
    expect(step2).not.toBeNull();
    expect(step2!.status).toBe('pending');
  });

  it('does not re-send or double-enqueue on a second tick (idempotent)', async () => {
    const seq = await seedSequence({});
    const enrollment = 'aaaaaaa2-0000-4000-8000-000000000002';
    await seedDueStep(seq.sequence_id, enrollment);

    await runSequenceTick(50); // step1 sent, step2 enqueued (due now, delay 0)
    const afterFirst = sendCount;
    await runSequenceTick(50); // step2 sends; step1 must NOT re-send

    // step1 sent exactly once.
    const step1Count = await dataService.one<{ c: string }>(
      `SELECT count(*)::text AS c FROM sequence.execution_step WHERE dedupe_key = $1 AND status = 'sent'`,
      [`${enrollment}:1`]);
    expect(step1Count!.c).toBe('1');
    // step2 exists exactly once (no duplicate enqueue).
    const step2Count = await dataService.one<{ c: string }>(
      `SELECT count(*)::text AS c FROM sequence.execution_step WHERE dedupe_key = $1`,
      [`${enrollment}:2`]);
    expect(step2Count!.c).toBe('1');
    expect(sendCount).toBeGreaterThan(afterFirst); // step2 did send on the 2nd tick
  });

  it('defers a step whose sequence is fully quiet (no send)', async () => {
    const seq = await seedSequence({ send_window: { quiet_start_hour: 0, quiet_end_hour: 24 } });
    const enrollment = 'aaaaaaa3-0000-4000-8000-000000000003';
    await seedDueStep(seq.sequence_id, enrollment);

    const r = await runSequenceTick(50);
    expect(r.deferred).toBe(1);
    expect(r.sent).toBe(0);
    expect(sendCount).toBe(0);

    const step1 = await dataService.one<{ status: string; next_run_at: string }>(
      `SELECT status, next_run_at FROM sequence.execution_step WHERE dedupe_key = $1`, [`${enrollment}:1`]);
    expect(step1!.status).toBe('deferred');
    expect(new Date(step1!.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('retries a failing send (attempt grows, status returns to pending)', async () => {
    forceFail = true;
    const seq = await seedSequence({});
    const enrollment = 'aaaaaaa4-0000-4000-8000-000000000004';
    await seedDueStep(seq.sequence_id, enrollment);

    const r = await runSequenceTick(50);
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(0);

    const step1 = await dataService.one<{ status: string; attempt_count: number; last_error: string }>(
      `SELECT status, attempt_count, last_error FROM sequence.execution_step WHERE dedupe_key = $1`,
      [`${enrollment}:1`]);
    expect(step1!.attempt_count).toBe(1);
    expect(step1!.status).toBe('pending'); // re-queued for backoff (< max attempts)
    expect(step1!.last_error).toContain('boom');
  });
});
