/**
 * Concurrent appends to one audit chain must not lose entries.
 *
 * This is a regression test for a real defect (fixed 2026-07-29): the head read,
 * the entry insert and the chain_head update ran as three separate autocommits, so
 * the `SELECT ... FOR UPDATE` on chain_head released its lock immediately. Two
 * concurrent appends read the same head_seq, both computed seq + 1, one won and the
 * other died on the (pool_index, seq) unique index — and since emitEvent logs and
 * swallows, the losing entry was silently dropped. It surfaced as
 * `[audit.emit] failed ... duplicate key value violates unique constraint
 * "entry_pool_index_seq_key"` under any concurrent workload.
 *
 * Opt in with AUDIT_IT=1 and a reachable Postgres: the guarantee is a database
 * guarantee, so testing it without a database would test nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { appendAuditEntry } from '../src/services/auditService';

const RUN_IT = process.env.AUDIT_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

/** A fresh chain per run — audit.entry is append-only, so nothing is cleaned up. */
const POOL = `concurrency-probe-${Date.now()}`;

suite('audit chain under concurrent appends', () => {
  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
  });

  afterAll(async () => {
    await closeAllPools();
  });

  it('assigns a gapless, unique seq to 25 simultaneous appends and loses none', async () => {
    const N = 25;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        appendAuditEntry({
          pool_index: POOL,
          event_type: 'vault.key.issued.v1',
          actor_kind: 'service',
          actor_id: 'concurrency-probe',
          payload: { i },
        }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    // Before the fix this reported roughly half the batch rejected on the unique index.
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
    ).toEqual([]);
    expect(results).toHaveLength(N);

    const rows = await dataService.rows<{ seq: string; prev_hash: Buffer | null; entry_hash: Buffer }>(
      `SELECT seq, prev_hash, entry_hash FROM audit.entry WHERE pool_index = $1 ORDER BY seq ASC`,
      [POOL],
    );
    expect(rows).toHaveLength(N);
    // 1..N exactly: no gaps (a lost entry) and no duplicates (an impossible chain).
    expect(rows.map((r) => Number(r.seq))).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    // Every entry links to its predecessor. Serialising the appends is what makes
    // this true: a chain assembled from interleaved reads would point several
    // entries at the same prev_hash.
    expect(rows[0].prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(Buffer.from(rows[i].prev_hash!).toString('hex'))
        .toBe(Buffer.from(rows[i - 1].entry_hash).toString('hex'));
    }

    // And the head agrees with the tail of the chain.
    const head = await dataService.one<{ head_seq: string; head_hash: Buffer }>(
      `SELECT head_seq, head_hash FROM audit.chain_head WHERE pool_index = $1`,
      [POOL],
    );
    expect(Number(head!.head_seq)).toBe(N);
    expect(Buffer.from(head!.head_hash).toString('hex'))
      .toBe(Buffer.from(rows[N - 1].entry_hash).toString('hex'));
  });

  it('serialises per chain, so two chains do not block each other into a wrong order', async () => {
    const A = `${POOL}-a`;
    const B = `${POOL}-b`;
    await Promise.all(
      [A, B].flatMap((pool) =>
        Array.from({ length: 5 }, (_, i) =>
          appendAuditEntry({
            pool_index: pool,
            event_type: 'vault.key.issued.v1',
            actor_kind: 'service',
            actor_id: 'concurrency-probe',
            payload: { i },
          }),
        ),
      ),
    );
    for (const pool of [A, B]) {
      const seqs = await dataService.rows<{ seq: string }>(
        `SELECT seq FROM audit.entry WHERE pool_index = $1 ORDER BY seq ASC`, [pool]);
      expect(seqs.map((s) => Number(s.seq))).toEqual([1, 2, 3, 4, 5]);
    }
  });
});
