/**
 * AC-11 tamper-injection drill: write a real meter usage_ledger_day chain
 * by emitting events, then mutate one day's total_units in Postgres and
 * confirm the verifier surfaces the break.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyMeterChain } from '../../src/services/chainVerifier';
import { startChaosCtx, type ChaosCtx } from '../../../sdk-vault/tests/chaos/setup';

const TENANT = '00000000-0000-0000-0000-000000000777';

function hashLedgerEntry(parts: {
  tenant_id: string;
  day: string;
  total_units: Record<string, number>;
  event_count: number;
  prev_hash: Buffer | null;
}): Buffer {
  const canonical = JSON.stringify({
    prev_hash: parts.prev_hash ? parts.prev_hash.toString('hex') : null,
    tenant_id: parts.tenant_id,
    day: parts.day,
    total_units: parts.total_units,
    event_count: parts.event_count,
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

async function insertDay(
  ctx: ChaosCtx,
  day: string,
  totals: Record<string, number>,
  count: number,
  prevHash: Buffer | null,
): Promise<Buffer> {
  const hash = hashLedgerEntry({ tenant_id: TENANT, day, total_units: totals, event_count: count, prev_hash: prevHash });
  await ctx.query(
    `INSERT INTO meter.usage_ledger_day (tenant_id, day, total_units, event_count, prev_hash, entry_hash)
     VALUES ($1, $2::date, $3::jsonb, $4, $5, $6)`,
    [TENANT, day, JSON.stringify(totals), count, prevHash, hash],
  );
  return hash;
}

describe('AC-11 · Meter chain verifier catches tampering', () => {
  let ctx: ChaosCtx;

  beforeAll(async () => { ctx = await startChaosCtx(); }, 180_000);
  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('detects total_units tamper across 3-day chain', async () => {
    const d1 = '2026-05-20';
    const d2 = '2026-05-21';
    const d3 = '2026-05-22';

    const h1 = await insertDay(ctx, d1, { 'identity.jwt.mint': 100 }, 100, null);
    const h2 = await insertDay(ctx, d2, { 'identity.jwt.mint': 250 }, 250, h1);
    const h3 = await insertDay(ctx, d3, { 'identity.jwt.mint': 175 }, 175, h2);
    expect(h1).toBeInstanceOf(Buffer);
    expect(h3).toBeInstanceOf(Buffer);

    // Clean chain verifies.
    const clean = await verifyMeterChain(TENANT);
    expect(clean.ok).toBe(true);
    expect(clean.days_checked).toBe(3);

    // Tamper: bump day 2's total_units without re-hashing.
    await ctx.query(
      `UPDATE meter.usage_ledger_day
          SET total_units = '{"identity.jwt.mint": 9999999}'::jsonb
        WHERE tenant_id = $1 AND day = $2::date`,
      [TENANT, d2],
    );

    const broken = await verifyMeterChain(TENANT);
    expect(broken.ok).toBe(false);
    expect(broken.break_at_day).toBe(d2);
    expect(broken.break_reason).toMatch(/entry_hash mismatch/);
  });
});
