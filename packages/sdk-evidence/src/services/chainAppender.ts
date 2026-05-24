import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import { computeEntryHash } from './chainVerifier';
import type { ChainOfCustodyAction } from '@projexlight/contracts';

/**
 * Chain-of-custody append helper (P7 FR-EVD-3 producer side).
 *
 * Pairs with verifyChain(): writes a new evidence.chain_of_custody row
 * computed with the canonical hash formula so verifyChain reproduces
 * the same entry_hash.
 *
 * Atomicity: a single transaction reads the current MAX(seq), computes
 * the next seq + entry_hash, and INSERTs. Concurrent appends for the
 * same capture_id race the UNIQUE(capture_id, seq) index — one INSERT
 * succeeds, others retry. retry loop bounded at 3 attempts.
 *
 * Audit linkage: every append also writes to sdk-audit.audit.entry via
 * the injected emitter so the chain_of_custody.audit_entry_id can point
 * at the canonical audit row. The audit hook is wired by api-gateway at
 * boot.
 */

export interface AppendChainEntryInput {
  capture_id: string;
  action: ChainOfCustodyAction;
  actor_persona_id: string;
  /** SHA-256 of the blob this entry attests to (raw or variant). */
  blob_checksum: Buffer;
  /** ID of the audit.entry row that mirrors this chain entry. */
  audit_entry_id: string;
}

export interface AppendChainEntryResult {
  entry_id: string;
  capture_id: string;
  seq: number;
  entry_hash: string;
  occurred_at: string;
}

const MAX_RETRIES = 3;
const ZERO_HASH = Buffer.alloc(32);

/**
 * Optional event emitter — gateway-installed. Drops the event when not
 * registered (tests don't need a Kafka stub).
 */
export type ChainAppendEventEmitter = (event: {
  event_type: 'evidence.chain.appended.v1';
  capture_id: string;
  entry_id: string;
  seq: number;
  action: ChainOfCustodyAction;
}) => Promise<void> | void;

let _emitter: ChainAppendEventEmitter = (event) => {
  console.log(
    `[chain-appender] would emit evidence.chain.appended.v1 capture=${event.capture_id} seq=${event.seq} (no emitter registered)`,
  );
};

export function setChainAppendEmitter(emitter: ChainAppendEventEmitter): void {
  _emitter = emitter;
}

/**
 * Append a new chain entry. Returns the persisted row's hash + seq.
 * Retries up to MAX_RETRIES on the unique-violation of (capture_id, seq)
 * which indicates a concurrent appender claimed the same seq.
 */
export async function appendChainEntry(
  input: AppendChainEntryInput,
): Promise<AppendChainEntryResult> {
  const pool = getPool();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the capture row to serialize appenders for the same capture.
      // FOR UPDATE prevents two concurrent appends from each reading the
      // same max(seq) and racing to INSERT seq=N. Concurrent appends to
      // DIFFERENT capture_ids stay parallel.
      await client.query(
        `SELECT capture_id FROM evidence.capture WHERE capture_id = $1 FOR UPDATE`,
        [input.capture_id],
      );

      // Find the current head of the chain.
      const head = await client.query<{ next_seq: number; prev_hash: Buffer | null }>(
        `SELECT COALESCE(MAX(seq) + 1, 0)::int AS next_seq,
                (SELECT entry_hash FROM evidence.chain_of_custody
                  WHERE capture_id = $1 ORDER BY seq DESC LIMIT 1) AS prev_hash
           FROM evidence.chain_of_custody
          WHERE capture_id = $1`,
        [input.capture_id],
      );

      const nextSeq = head.rows[0]?.next_seq ?? 0;
      const prevHash: Buffer = head.rows[0]?.prev_hash ?? ZERO_HASH;

      const entryHash = computeEntryHash({
        prev_hash: prevHash,
        blob_checksum: input.blob_checksum,
        action: input.action,
        actor_persona_id: input.actor_persona_id,
        seq: nextSeq,
      });

      const entryId = `coc_${crypto.randomBytes(10).toString('hex')}`;
      const { rows } = await client.query<{ occurred_at: Date }>(
        `INSERT INTO evidence.chain_of_custody
           (entry_id, capture_id, seq, action, actor_persona_id,
            blob_checksum, prev_hash, entry_hash, audit_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING occurred_at`,
        [
          entryId,
          input.capture_id,
          nextSeq,
          input.action,
          input.actor_persona_id,
          input.blob_checksum,
          prevHash,
          entryHash,
          input.audit_entry_id,
        ],
      );
      await client.query('COMMIT');

      const result: AppendChainEntryResult = {
        entry_id: entryId,
        capture_id: input.capture_id,
        seq: nextSeq,
        entry_hash: entryHash.toString('hex'),
        occurred_at: rows[0].occurred_at.toISOString(),
      };

      // Best-effort event emission outside the transaction.
      try {
        await _emitter({
          event_type: 'evidence.chain.appended.v1',
          capture_id: input.capture_id,
          entry_id: entryId,
          seq: nextSeq,
          action: input.action,
        });
      } catch (err) {
        console.warn('[chain-appender] emit failed:', (err as Error).message);
      }

      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Unique violation on (capture_id, seq) → another appender won. Retry.
      const code = (err as { code?: string }).code;
      if (code === '23505' && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw new Error(`appendChainEntry: exhausted ${MAX_RETRIES} retries for capture ${input.capture_id}`);
}
