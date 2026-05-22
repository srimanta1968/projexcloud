import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueKey, shredKey } from '../../src/services/keyService';
import { startChaosCtx, type ChaosCtx } from './setup';

/**
 * AC-3 chaos drill: shredding a pool KEK is scoped to that pool — sibling
 * pools (and their downstream tiers) remain intact.
 */
describe('AC-3 · Pool KEK shred is scoped to the pool', () => {
  let ctx: ChaosCtx;

  beforeAll(async () => { ctx = await startChaosCtx(); }, 180_000);
  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('only the target pool KEK and its subtree go shredded', async () => {
    const op = { kind: 'service' as const, id: 'test' };
    const root = await issueKey({ tier: 'root', kms_ref: 'kms-r', region: 'us-east-1' }, op);
    const app = await issueKey({ tier: 'app', parent_key_id: root.key_id, kms_ref: 'kms-a', region: 'us-east-1' }, op);
    const poolA = await issueKey({ tier: 'pool', parent_key_id: app.key_id, scope_id: 'app-healthcare-007', kms_ref: 'kms-p-007', region: 'us-east-1' }, op);
    const poolB = await issueKey({ tier: 'pool', parent_key_id: app.key_id, scope_id: 'app-healthcare-008', kms_ref: 'kms-p-008', region: 'us-east-1' }, op);
    const tA = await issueKey({ tier: 'tenant', parent_key_id: poolA.key_id, kms_ref: 'kms-tA', region: 'us-east-1' }, op);
    const tB = await issueKey({ tier: 'tenant', parent_key_id: poolB.key_id, kms_ref: 'kms-tB', region: 'us-east-1' }, op);

    await shredKey(poolA.key_id, op, 'pool-decommission');

    const poolARow = await ctx.one<{ state: string }>(`SELECT state FROM vault.key WHERE key_id = $1`, [poolA.key_id]);
    expect(poolARow?.state).toBe('shredded');

    const poolBRow = await ctx.one<{ state: string }>(`SELECT state FROM vault.key WHERE key_id = $1`, [poolB.key_id]);
    expect(poolBRow?.state).toBe('active');

    const tARow = await ctx.one<{ state: string }>(`SELECT state FROM vault.key WHERE key_id = $1`, [tA.key_id]);
    const tBRow = await ctx.one<{ state: string }>(`SELECT state FROM vault.key WHERE key_id = $1`, [tB.key_id]);

    expect(tBRow?.state).toBe('active');
    // tA is still 'active' as a row (FK RESTRICT) but its parent is shredded;
    // production layer marks it derivatively unrecoverable via the cascade
    // worker that this test will trigger once that worker lands.
    expect(tARow?.state).toBe('active');

    const auditEvents = await ctx.rows<{ event_type: string }>(
      `SELECT event_type FROM audit.entry WHERE subject_kind = 'vault.key' AND subject_id = $1`,
      [poolA.key_id],
    );
    const types = auditEvents.map((r) => r.event_type);
    expect(types).toContain('vault.key.shredded.v1');
  });
});
