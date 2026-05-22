import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import type { ActorKind } from './auditService';

export interface VerifyRequest {
  pool_index: string;
  from_seq?: number;
  to_seq?: number;
}

export interface VerifyProof {
  pool_index: string;
  from_seq: number;
  to_seq: number;
  entries_checked: number;
  ok: boolean;
  break_at_seq: number | null;
  break_reason: string | null;
  head_hash_hex: string | null;
  verified_at: Date;
}

interface PartialEntry {
  seq: string;
  event_type: string;
  occurred_at: Date;
  actor_kind: ActorKind;
  actor_id: string;
  tenant_id: string | null;
  payload: unknown;
  prev_hash: Buffer | null;
  entry_hash: Buffer;
}

function recomputeHash(pool_index: string, e: PartialEntry): Buffer {
  const canonical = JSON.stringify({
    prev_hash: e.prev_hash ? e.prev_hash.toString('hex') : null,
    pool_index,
    seq: Number(e.seq),
    event_type: e.event_type,
    payload: e.payload,
    actor_kind: e.actor_kind,
    actor_id: e.actor_id,
    tenant_id: e.tenant_id,
    occurred_at: e.occurred_at.toISOString(),
  });
  return crypto.createHash('sha256').update(canonical).digest();
}

/**
 * Walks `audit.entry` for the given pool from `from_seq` to `to_seq` (inclusive),
 * recomputes each entry's hash against the canonical canonicalization, and
 * compares to the persisted entry_hash. Returns a proof object; updates
 * `audit.chain_head.last_verified_at` on success.
 *
 * Per P1-Foundation-Spine §7: detection of any tampered entry must surface as
 * an `audit.chain.break.v1` event for the verifier daemon to emit.
 */
export async function verifyChain(req: VerifyRequest): Promise<VerifyProof> {
  const verified_at = new Date();
  try {
    const params: unknown[] = [req.pool_index];
    let where = `pool_index = $1`;
    if (req.from_seq != null) {
      params.push(req.from_seq);
      where += ` AND seq >= $${params.length}`;
    }
    if (req.to_seq != null) {
      params.push(req.to_seq);
      where += ` AND seq <= $${params.length}`;
    }

    const rows = await dataService.rows<PartialEntry>(
      `SELECT seq, event_type, occurred_at, actor_kind, actor_id, tenant_id,
              payload, prev_hash, entry_hash
         FROM audit.entry
        WHERE ${where}
        ORDER BY seq ASC`,
      params,
    );

    if (rows.length === 0) {
      return {
        pool_index: req.pool_index,
        from_seq: req.from_seq ?? 0,
        to_seq: req.to_seq ?? 0,
        entries_checked: 0,
        ok: true,
        break_at_seq: null,
        break_reason: null,
        head_hash_hex: null,
        verified_at,
      };
    }

    let expectedPrev: Buffer | null = rows[0].prev_hash;
    let lastHash: Buffer = rows[0].entry_hash;
    for (const e of rows) {
      if ((e.prev_hash === null) !== (expectedPrev === null) ||
          (e.prev_hash && expectedPrev && !e.prev_hash.equals(expectedPrev))) {
        return {
          pool_index: req.pool_index,
          from_seq: Number(rows[0].seq),
          to_seq: Number(e.seq),
          entries_checked: rows.indexOf(e) + 1,
          ok: false,
          break_at_seq: Number(e.seq),
          break_reason: 'prev_hash does not match the previous entry_hash',
          head_hash_hex: null,
          verified_at,
        };
      }
      const recomputed = recomputeHash(req.pool_index, e);
      if (!recomputed.equals(e.entry_hash)) {
        return {
          pool_index: req.pool_index,
          from_seq: Number(rows[0].seq),
          to_seq: Number(e.seq),
          entries_checked: rows.indexOf(e) + 1,
          ok: false,
          break_at_seq: Number(e.seq),
          break_reason: 'entry_hash mismatch — payload tampered or canonicalization drift',
          head_hash_hex: null,
          verified_at,
        };
      }
      expectedPrev = e.entry_hash;
      lastHash = e.entry_hash;
    }

    await dataService.query(
      `UPDATE audit.chain_head SET last_verified_at = $1 WHERE pool_index = $2`,
      [verified_at, req.pool_index],
    );

    return {
      pool_index: req.pool_index,
      from_seq: Number(rows[0].seq),
      to_seq: Number(rows[rows.length - 1].seq),
      entries_checked: rows.length,
      ok: true,
      break_at_seq: null,
      break_reason: null,
      head_hash_hex: lastHash.toString('hex'),
      verified_at,
    };
  } catch (err) {
    throw err;
  }
}
