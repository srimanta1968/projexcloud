import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';

/**
 * Meter usage-ledger hash-chain verifier (AC-11). Walks
 * meter.usage_ledger_day per tenant, recomputes each day's hash, compares
 * to the stored entry_hash. Any mismatch surfaces as a break event.
 *
 * The chain shape mirrors auditService: entry_hash[N] = SHA256({
 *   prev_hash, tenant_id, day, total_units, event_count
 * }) — see meter-collector.hashLedgerEntry().
 */

export interface MeterChainBreak {
  tenant_id: string;
  day: string;
  reason: string;
  expected_hash: string;
  stored_hash: string;
}

export interface MeterChainProof {
  tenant_id: string;
  days_checked: number;
  ok: boolean;
  break_at_day: string | null;
  break_reason: string | null;
  verified_at: Date;
}

interface DayRow {
  day: string;
  total_units: Record<string, number>;
  event_count: string;
  prev_hash: Buffer | null;
  entry_hash: Buffer;
}

function recompute(parts: {
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

/**
 * Verify the (tenant, day) chain for one tenant. Returns a proof object; the
 * chain is `ok=false` with break details if any row has been tampered.
 */
export async function verifyMeterChain(tenant_id: string): Promise<MeterChainProof> {
  const verified_at = new Date();
  try {
    const rows = await dataService.rows<DayRow>(
      `SELECT day::text AS day, total_units, event_count, prev_hash, entry_hash
         FROM meter.usage_ledger_day
        WHERE tenant_id = $1
        ORDER BY day ASC`,
      [tenant_id],
    );

    if (rows.length === 0) {
      return { tenant_id, days_checked: 0, ok: true, break_at_day: null, break_reason: null, verified_at };
    }

    let expectedPrev: Buffer | null = null;
    for (const r of rows) {
      // prev_hash must match the previous row's entry_hash (or null at genesis).
      if ((r.prev_hash === null) !== (expectedPrev === null) ||
          (r.prev_hash && expectedPrev && !r.prev_hash.equals(expectedPrev))) {
        return {
          tenant_id,
          days_checked: rows.indexOf(r) + 1,
          ok: false,
          break_at_day: r.day,
          break_reason: 'prev_hash does not match prior day entry_hash',
          verified_at,
        };
      }
      const expected = recompute({
        tenant_id,
        day: r.day,
        total_units: r.total_units,
        event_count: Number(r.event_count),
        prev_hash: r.prev_hash,
      });
      if (!expected.equals(r.entry_hash)) {
        return {
          tenant_id,
          days_checked: rows.indexOf(r) + 1,
          ok: false,
          break_at_day: r.day,
          break_reason: 'entry_hash mismatch — total_units or event_count was tampered',
          verified_at,
        };
      }
      expectedPrev = r.entry_hash;
    }

    return {
      tenant_id,
      days_checked: rows.length,
      ok: true,
      break_at_day: null,
      break_reason: null,
      verified_at,
    };
  } catch (err) {
    throw err;
  }
}

/**
 * Iterates every tenant in meter.usage_ledger_day, runs verifyMeterChain.
 * Returns the list of broken tenants. Used by the scheduler + reconciler.
 */
export async function verifyAllMeterChains(): Promise<MeterChainProof[]> {
  try {
    const tenants = await dataService.rows<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM meter.usage_ledger_day`,
    );
    const proofs: MeterChainProof[] = [];
    for (const t of tenants) {
      const proof = await verifyMeterChain(t.tenant_id);
      proofs.push(proof);
    }
    return proofs;
  } catch (err) {
    throw err;
  }
}
