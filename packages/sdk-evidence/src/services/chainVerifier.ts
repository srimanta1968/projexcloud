import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';

/**
 * Chain-of-custody verifier (P7 FR-EVD-3 / AC-9).
 *
 * Re-computes the hash chain stored in evidence.chain_of_custody and
 * compares each entry_hash to the recomputed value. Detects:
 *
 *   - gap         : seq numbers are not 0..N-1 (a row is missing)
 *   - wrong-prev  : an entry's prev_hash doesn't match the previous entry's entry_hash
 *   - hash-mismatch: an entry's recomputed entry_hash doesn't match what's stored
 *                    (indicates a row was tampered with after being written)
 *
 * Hash formula (must match the producer that writes chain entries):
 *   entry_hash = sha256(prev_hash || blob_checksum || action || actor || seq)
 *
 * Inputs are concatenated as raw bytes:
 *   - prev_hash      : 32 bytes (genesis entry uses 32 zero bytes)
 *   - blob_checksum  : 32 bytes (sha256 of the relevant blob)
 *   - action         : UTF-8 bytes of the action enum string
 *   - actor          : UTF-8 bytes of the actor_persona_id
 *   - seq            : 4-byte big-endian uint32
 *
 * This is the canonical algorithm; if the producer ever diverges, AC-9
 * breaks. The same function is exposed so callers writing new entries
 * compute the same hash.
 */

export type ChainFailureReason = 'gap' | 'wrong-prev' | 'hash-mismatch';

export interface ChainVerifyReport {
  capture_id: string;
  verified: boolean;
  entry_count: number;
  /** Lowest seq number that failed; undefined when verified=true. */
  failed_seq?: number;
  failure_reason?: ChainFailureReason;
  /** Hex-encoded hashes when a hash-mismatch is detected. */
  expected_hash?: string;
  actual_hash?: string;
  /** Hex-encoded prev_hash mismatch values. */
  expected_prev?: string;
  actual_prev?: string;
}

const ZERO_HASH = Buffer.alloc(32);

/**
 * Compute the canonical entry_hash for one chain step. Exposed so the
 * capture-intake / chain-append code (when it lands) computes hashes the
 * same way the verifier expects.
 */
export function computeEntryHash(input: {
  prev_hash: Buffer;
  blob_checksum: Buffer;
  action: string;
  actor_persona_id: string;
  seq: number;
}): Buffer {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(input.seq, 0);
  const hash = crypto.createHash('sha256');
  hash.update(input.prev_hash);
  hash.update(input.blob_checksum);
  hash.update(Buffer.from(input.action, 'utf8'));
  hash.update(Buffer.from(input.actor_persona_id, 'utf8'));
  hash.update(seqBuf);
  return hash.digest();
}

/**
 * Verify the full chain for one capture_id. Returns a typed report; never
 * throws on verification failure — only throws on DB errors so callers can
 * distinguish infrastructure failures from tamper detection.
 */
export async function verifyChain(captureId: string): Promise<ChainVerifyReport> {
  const pool = getPool();
  const { rows } = await pool.query<{
    seq: number;
    action: string;
    actor_persona_id: string;
    blob_checksum: Buffer;
    prev_hash: Buffer;
    entry_hash: Buffer;
  }>(
    `SELECT seq, action, actor_persona_id, blob_checksum, prev_hash, entry_hash
       FROM evidence.chain_of_custody
      WHERE capture_id = $1
      ORDER BY seq ASC`,
    [captureId],
  );

  const entryCount = rows.length;
  if (entryCount === 0) {
    return { capture_id: captureId, verified: true, entry_count: 0 };
  }

  let expectedPrev: Buffer = ZERO_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Gap detection: seq must be 0, 1, 2, ...
    if (row.seq !== i) {
      return {
        capture_id: captureId,
        verified: false,
        entry_count: entryCount,
        failed_seq: row.seq,
        failure_reason: 'gap',
      };
    }

    // Prev-hash linkage: this entry's prev_hash must equal the previous
    // entry's entry_hash (or the zero hash for the genesis entry).
    if (!row.prev_hash.equals(expectedPrev)) {
      return {
        capture_id: captureId,
        verified: false,
        entry_count: entryCount,
        failed_seq: row.seq,
        failure_reason: 'wrong-prev',
        expected_prev: expectedPrev.toString('hex'),
        actual_prev: row.prev_hash.toString('hex'),
      };
    }

    // Hash recomputation: the stored entry_hash must equal what we compute
    // from the row's other fields. Any byte-level tampering breaks this.
    const recomputed = computeEntryHash({
      prev_hash: row.prev_hash,
      blob_checksum: row.blob_checksum,
      action: row.action,
      actor_persona_id: row.actor_persona_id,
      seq: row.seq,
    });
    if (!recomputed.equals(row.entry_hash)) {
      return {
        capture_id: captureId,
        verified: false,
        entry_count: entryCount,
        failed_seq: row.seq,
        failure_reason: 'hash-mismatch',
        expected_hash: recomputed.toString('hex'),
        actual_hash: row.entry_hash.toString('hex'),
      };
    }

    expectedPrev = row.entry_hash;
  }

  return { capture_id: captureId, verified: true, entry_count: entryCount };
}

/**
 * Batch verifier — verifies many captures in parallel and returns the
 * report for each. Used by the legal-export bundler to populate the
 * chain_verifications jsonb column on evidence.legal_export.
 */
export async function verifyChains(captureIds: string[]): Promise<ChainVerifyReport[]> {
  return Promise.all(captureIds.map(verifyChain));
}
