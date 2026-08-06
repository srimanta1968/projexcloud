import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * The sync DLQ: retry-tick settlement, manual replay and reconciliation (P15·E5).
 *
 * WHY THIS FILE EXISTS. The acceptance criterion is "connector DLQ replay and reconcile
 * actually WORK rather than returning stubs", and nothing exercised them: no test in this
 * package referenced runRetryTick, reconcileSyncState, replayDlq or replayDlqForTenant.
 * The handlers are real rather than stubs — that much is visible by reading them — but
 * "the code looks right" is exactly the evidence the criterion refuses, because a stub and
 * a subtly-wrong UPDATE are indistinguishable from the route's 200.
 *
 * WHAT IS ASSERTED HERE AND WHAT IS NOT. Everything below is settlement and reconciliation
 * state, which is pure SQL over connectors.sync_deadletter and needs no adapter. The
 * resolved and requeued-with-backoff branches of runRetryTick are NOT asserted here: both
 * re-drive through syncConnector() against a live third-party install, so proving them
 * needs an adapter fixture rather than a row. What IS asserted of the worker is the branch
 * that terminates without an adapter — an entry with no install to re-drive against — plus
 * the guarantee that matters operationally either way: a claimed entry is never left
 * wedged in 'retrying'.
 *
 * Skips itself when no database is reachable, and FAILS LOUD rather than passing silently
 * when the schema is missing — same contract as the sibling suites in this package.
 */

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
const TENANT = randomUUID();

let worker: typeof import('../src/services/syncRetryWorker');
let svc: typeof import('../src/services/connectorsService');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM connectors.sync_deadletter LIMIT 1');
    dbUp = true;
  } catch (err) {
    dbUp = false;
    if (!SKIP_DB_TESTS) {
      throw new Error(
        `[db-gate] database or schema unavailable, so this suite cannot verify anything: `
        + `${(err as Error).message}\n`
        + `  Apply migrations first (MIGRATE_ONLY=1 on the gateway), or set `
        + `SKIP_DB_TESTS=1 to skip these cases visibly instead of passing them silently.`,
      );
    }
    return;
  }
  worker = await import('../src/services/syncRetryWorker');
  svc = await import('../src/services/connectorsService');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM connectors.sync_deadletter WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

/**
 * A dead-letter with NO install_id. Deliberate: install_id is FK to connectors.install,
 * so a row without one needs no connector fixture, and it is also the real uninstalled
 * case the worker has to terminate rather than retry forever.
 */
async function deadletter(opts: {
  status?: string;
  attempts?: number;
  max_attempts?: number;
  next_retry_at?: string | null;
  last_attempt_at?: string | null;
  sync_kind?: string | null;
  external_ref?: string | null;
  first_failed_at?: string;
} = {}): Promise<string> {
  const r = await dataService.one<{ deadletter_id: string }>(
    `INSERT INTO connectors.sync_deadletter
       (tenant_id, connector_kind, sync_kind, external_ref, status, attempts, max_attempts,
        next_retry_at, last_attempt_at, first_failed_at)
     VALUES ($1::uuid, 'test_kind', $2, $3, $4, $5, $6,
             $7::timestamptz, $8::timestamptz, COALESCE($9::timestamptz, now()))
     RETURNING deadletter_id::text`,
    [
      TENANT,
      opts.sync_kind ?? null,
      opts.external_ref ?? null,
      opts.status ?? 'dlq',
      opts.attempts ?? 0,
      opts.max_attempts ?? 5,
      opts.next_retry_at === undefined ? null : opts.next_retry_at,
      opts.last_attempt_at === undefined ? null : opts.last_attempt_at,
      opts.first_failed_at ?? null,
    ],
  );
  return r!.deadletter_id;
}

async function stateOf(deadletter_id: string) {
  return dataService.one<{
    status: string; attempts: number; error: string | null;
    next_retry_at: Date | null; resolved_at: Date | null;
  }>(
    `SELECT status, attempts, error, next_retry_at, resolved_at
       FROM connectors.sync_deadletter WHERE deadletter_id = $1::uuid`,
    [deadletter_id],
  );
}

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() reports SKIPPED. A bare return reports PASSED, which is
    // indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

describe('retry-tick settlement (AC2)', () => {
  maybe('discards an entry with no install to re-drive, instead of retrying forever', async () => {
    const id = await deadletter({ attempts: 0, max_attempts: 5 });

    const result = await worker.runRetryTick(50);
    expect(result.claimed).toBeGreaterThanOrEqual(1);

    const after = await stateOf(id);
    // Terminal, and terminal on the FIRST tick rather than after five: retrying an entry
    // whose install is gone cannot succeed on attempt 5 either, so burning the budget
    // would only delay the operator seeing it.
    expect(after!.status).toBe('discarded');
    expect(after!.attempts).toBe(1);
    expect(after!.error).toMatch(/no install_id/i);
  });

  maybe('never leaves a claimed entry wedged in retrying', async () => {
    const id = await deadletter();
    await worker.runRetryTick(50);
    // 'retrying' is a claim, not a resting state. An entry left there is invisible to the
    // next tick (it looks in-flight) and to the operator (it looks like progress).
    expect((await stateOf(id))!.status).not.toBe('retrying');
  });

  maybe('leaves an entry whose backoff has not expired alone', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const id = await deadletter({ next_retry_at: future });

    await worker.runRetryTick(50);

    const after = await stateOf(id);
    // Untouched: still queued, still zero attempts. A tick that ignored next_retry_at
    // would drain the whole queue on the first pass and the backoff would mean nothing.
    expect(after!.status).toBe('dlq');
    expect(after!.attempts).toBe(0);
  });
});

describe('manual replay (AC2)', () => {
  maybe('revives a discarded entry, which is the whole point of replay', async () => {
    const id = await deadletter({ status: 'discarded', attempts: 5 });

    const row = await svc.replayDlq({ deadletter_id: id });
    expect(row).not.toBeNull();

    const after = await stateOf(id);
    // 'discarded' is terminal for the WORKER but not for a human: replay is the documented
    // manual continuation, so a discarded entry must be reachable again or the DLQ is a
    // place work goes to die.
    expect(after!.status).toBe('retrying');
    expect(after!.next_retry_at).not.toBeNull();
  });

  maybe('reports a replay of something already resolved as not found', async () => {
    const id = await deadletter({ status: 'resolved' });
    // Not an error, and not a silent success either: re-driving work that already
    // succeeded is how a connector produces duplicates downstream.
    expect(await svc.replayDlq({ deadletter_id: id })).toBeNull();
  });

  maybe('bulk replay covers a tenant and can be narrowed by connector kind', async () => {
    const a = await deadletter({ status: 'dlq' });
    const b = await deadletter({ status: 'discarded' });

    const count = await svc.replayDlqForTenant(TENANT, 'test_kind');
    expect(count).toBeGreaterThanOrEqual(2);
    expect((await stateOf(a))!.status).toBe('retrying');
    expect((await stateOf(b))!.status).toBe('retrying');

    // A kind nobody uses matches nothing — the filter is applied, not ignored.
    expect(await svc.replayDlqForTenant(TENANT, 'no_such_kind')).toBe(0);
  });
});

describe('reconciliation (AC2)', () => {
  maybe('keeps only the newest of several failures for the same external ref', async () => {
    const ref = `ext-${randomUUID()}`;
    const older = await deadletter({
      sync_kind: 'contacts', external_ref: ref,
      first_failed_at: new Date(Date.now() - 7_200_000).toISOString(),
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const newer = await deadletter({
      sync_kind: 'contacts', external_ref: ref,
      first_failed_at: new Date(Date.now() - 60_000).toISOString(),
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const result = await worker.reconcileSyncState(TENANT);
    expect(result.superseded).toBeGreaterThanOrEqual(1);

    // The later failure supersedes the earlier one for the same record: re-driving both
    // would push the same external record twice.
    expect((await stateOf(older))!.status).toBe('resolved');
    expect((await stateOf(newer))!.status).toBe('dlq');
  });

  maybe('does not collapse entries that merely share a tenant', async () => {
    const a = await deadletter({
      sync_kind: 'contacts', external_ref: `ext-${randomUUID()}`,
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const b = await deadletter({
      sync_kind: 'contacts', external_ref: `ext-${randomUUID()}`,
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await worker.reconcileSyncState(TENANT);

    // Different external_refs are different records. Collapsing them would silently
    // drop real failures, which is worse than the duplicate it was trying to fix.
    expect((await stateOf(a))!.status).toBe('dlq');
    expect((await stateOf(b))!.status).toBe('dlq');
  });

  maybe('requeues an entry a crashed worker left mid-drive', async () => {
    const id = await deadletter({
      status: 'retrying',
      last_attempt_at: new Date(Date.now() - 7_200_000).toISOString(),
    });

    const result = await worker.reconcileSyncState(TENANT, { staleRetryingMs: 3_600_000 });
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const after = await stateOf(id);
    // Back on the queue rather than wedged: a pod that died mid-tick must not strand the
    // entry, because nothing else ever revisits a row that looks in-flight.
    expect(after!.status).toBe('dlq');
    expect(after!.next_retry_at).not.toBeNull();
  });

  maybe('leaves a freshly-claimed entry alone', async () => {
    const id = await deadletter({ status: 'retrying', last_attempt_at: new Date().toISOString() });
    await worker.reconcileSyncState(TENANT, { staleRetryingMs: 3_600_000 });
    // Still in flight. Requeuing it would have two workers driving the same entry.
    expect((await stateOf(id))!.status).toBe('retrying');
  });

  maybe('is idempotent, so an operator can run it twice without consequence', async () => {
    const ref = `ext-${randomUUID()}`;
    await deadletter({ sync_kind: 'contacts', external_ref: ref,
      first_failed_at: new Date(Date.now() - 7_200_000).toISOString(),
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString() });
    await deadletter({ sync_kind: 'contacts', external_ref: ref,
      first_failed_at: new Date(Date.now() - 60_000).toISOString(),
      next_retry_at: new Date(Date.now() + 3_600_000).toISOString() });

    await worker.reconcileSyncState(TENANT);
    const second = await worker.reconcileSyncState(TENANT);
    expect(second.superseded).toBe(0);
    expect(second.requeued).toBe(0);
  });
});
