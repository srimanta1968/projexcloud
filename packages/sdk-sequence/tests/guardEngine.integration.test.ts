/**
 * Integration tests for the sdk-sequence frequency-cap + circuit-breaker guard
 * engine. Opt-in: SEQUENCE_IT=1 + a DB connection (DATABASE_URL / PG* env).
 *
 * Covers per-lead cooldown, max-messages window cap, content dedup, the circuit
 * breaker open/half-open/close cycle, and the guard audit log.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initPool, closeAllPools, dataService } from '@projexlight/db-runtime';
import {
  checkFrequencyGuards,
  recordChannelOutcome,
  upsertGuardConfig,
  listGuardLog,
} from '../src/services/guardEngine';

const RUN = process.env.SEQUENCE_IT === '1';
const suite = RUN ? describe : describe.skip;

const TENANT = 'f3f3f3f3-0000-4000-8000-0000000000cc';
const SEQ = 'f3f3f3f3-0000-4000-8000-0000000000dd';

async function seedSentTouch(subject: string, agoSeconds: number): Promise<void> {
  await dataService.query(
    `INSERT INTO sequence.execution_step
       (tenant_id, enrollment_id, sequence_id, step_number, subject_persona_id, channel,
        action, status, executed_at)
     VALUES ($1, gen_random_uuid(), $2, 1, $3, 'email', 'send', 'sent',
             now() - ($4 || ' seconds')::interval)`,
    [TENANT, SEQ, subject, String(agoSeconds)],
  );
}

async function cleanup(): Promise<void> {
  await dataService.query(`DELETE FROM sequence.execution_step WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.guard_log WHERE tenant_id = $1`, [TENANT]);
  await dataService.query(`DELETE FROM sequence.circuit_breaker WHERE tenant_id = $1`, [TENANT]);
}

suite('sdk-sequence guard engine (integration)', () => {
  beforeAll(async () => {
    initPool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
    // Deterministic thresholds: 1h cooldown, 3 per 24h, breaker opens at 3 fails.
    await upsertGuardConfig(TENANT, {
      enabled: true,
      cooldown_seconds: 3600,
      max_messages: 3,
      window_seconds: 86400,
      breaker_failure_threshold: 3,
      breaker_cooldown_seconds: 300,
    });
    // Ensure the sequence FK target exists (execution_step.sequence_id -> sequence).
    await dataService.query(
      `INSERT INTO sequence.sequence (sequence_id, tenant_id, name)
       VALUES ($1, $2, 'guard-it') ON CONFLICT (sequence_id) DO NOTHING`,
      [SEQ, TENANT],
    );
  });

  afterAll(async () => {
    await cleanup();
    await dataService.query(`DELETE FROM sequence.sequence WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM sequence.guard_config WHERE tenant_id = $1`, [TENANT]);
    await closeAllPools();
  });

  beforeEach(cleanup);

  it('allows a fresh subject and logs the allow decision', async () => {
    const subject = 'b0000001-0000-4000-8000-000000000001';
    const d = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
    const log = await listGuardLog(TENANT, { limit: 10 });
    expect(log[0].decision).toBe('allow');
  });

  it('blocks within the cooldown window', async () => {
    const subject = 'b0000002-0000-4000-8000-000000000002';
    await seedSentTouch(subject, 60); // sent 1 minute ago, cooldown is 1h
    const d = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('cooldown');
  });

  it('blocks once the max-messages window cap is reached', async () => {
    const subject = 'b0000003-0000-4000-8000-000000000003';
    // 3 sends within the window but all older than the 1h cooldown.
    await seedSentTouch(subject, 7200);
    await seedSentTouch(subject, 9000);
    await seedSentTouch(subject, 10800);
    const d = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('max_messages');
  });

  it('blocks a duplicate content hash within the window', async () => {
    const subject = 'b0000004-0000-4000-8000-000000000004';
    const hash = 'sha-abc123';
    const first = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email', dedupe_hash: hash });
    expect(first.allowed).toBe(true);
    const second = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email', dedupe_hash: hash });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('duplicate');
  });

  it('opens the circuit breaker after the failure threshold, then blocks', async () => {
    const subject = 'b0000005-0000-4000-8000-000000000005';
    let state;
    state = await recordChannelOutcome(TENANT, 'email', false);
    expect(state.state).toBe('closed');
    state = await recordChannelOutcome(TENANT, 'email', false);
    expect(state.state).toBe('closed');
    state = await recordChannelOutcome(TENANT, 'email', false); // 3rd failure -> open
    expect(state.state).toBe('open');
    expect(state.failure_count).toBe(3);

    const d = await checkFrequencyGuards({ tenant_id: TENANT, subject_persona_id: subject, channel: 'email' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('circuit_open');
  });

  it('closes the breaker on a success after opening', async () => {
    await recordChannelOutcome(TENANT, 'sms', false);
    await recordChannelOutcome(TENANT, 'sms', false);
    await recordChannelOutcome(TENANT, 'sms', false); // open
    const closed = await recordChannelOutcome(TENANT, 'sms', true); // success -> closed
    expect(closed.state).toBe('closed');
    expect(closed.failure_count).toBe(0);
  });
});
