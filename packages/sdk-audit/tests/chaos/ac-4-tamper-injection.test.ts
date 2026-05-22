/**
 * AC-4 tamper-injection drill: tamper a row in audit.entry, then run the
 * chain verifier, assert the break is detected with the offending pool+seq.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAuditEntry } from '../../src/services/auditService';
import { verifyChain } from '../../src/services/chainVerifier';
import { startChaosCtx, type ChaosCtx } from '../../../sdk-vault/tests/chaos/setup';

describe('AC-4 · Audit chain verifier catches tampering', () => {
  let ctx: ChaosCtx;

  beforeAll(async () => { ctx = await startChaosCtx(); }, 180_000);
  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('detects entry_hash mismatch after row tamper', async () => {
    // Append 3 entries to one pool's chain.
    const POOL = 'app-healthcare-test';
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry({
        pool_index: POOL,
        event_type: 'vault.key.issued.v1',
        actor_kind: 'service',
        actor_id: 'tamper-test',
        payload: { i },
      });
    }

    // Verify clean chain passes.
    const clean = await verifyChain({ pool_index: POOL });
    expect(clean.ok).toBe(true);
    expect(clean.entries_checked).toBe(3);

    // Tamper: mutate the middle entry's payload directly in Postgres. Append-
    // only triggers will block this in production; we bypass for the drill
    // by temporarily disabling them.
    await ctx.query(`ALTER TABLE audit.entry DISABLE TRIGGER USER`);
    await ctx.query(
      `UPDATE audit.entry SET payload = '{"tampered":true}'::jsonb WHERE pool_index = $1 AND seq = 2`,
      [POOL],
    );
    await ctx.query(`ALTER TABLE audit.entry ENABLE TRIGGER USER`);

    // Verify now detects break.
    const broken = await verifyChain({ pool_index: POOL });
    expect(broken.ok).toBe(false);
    expect(broken.break_at_seq).toBe(2);
    expect(broken.break_reason).toMatch(/entry_hash mismatch/);
  });
});
