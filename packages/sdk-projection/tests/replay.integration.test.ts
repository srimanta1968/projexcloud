import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Replay against a REAL Postgres. AC4 in particular is only meaningful measured — a 10k
 * assertion subject is built and timed here rather than asserted by inspection.
 */

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

/** The request budget AC4 is measured against. */
const REQUEST_BUDGET_MS = 3000;

// Explicit opt-out. Unset (the CI default) means an unreachable database FAILS this
// suite rather than quietly passing it. See the catch block below.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
const TENANT = randomUUID();
let replay: typeof import('../src/services/replayService');
let proj: typeof import('../src/services/explainedProjectionService');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM projection.replay_snapshot LIMIT 1');
    dbUp = true;
  } catch (err) {
    dbUp = false;
    // FAIL LOUD. A suite that cannot reach its schema has verified nothing, and a run
    // that reports green having verified nothing is worse than a red one: it is a false
    // all-clear that nobody investigates. Skipping remains available, but it must be
    // asked for explicitly and it then reports as SKIPPED rather than as PASSED.
    if (!SKIP_DB_TESTS) {
      throw new Error(
        '[db-gate] database or schema unavailable, so this suite cannot verify '
        + `anything: ${(err as Error).message}. `
        + 'Apply migrations first (MIGRATE_ONLY=1 on the gateway), or set '
        + 'SKIP_DB_TESTS=1 to skip these cases visibly instead of passing them silently.',
      );
    }
    return;
  }
  replay = await import('../src/services/replayService');
  proj = await import('../src/services/explainedProjectionService');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM projection.replay_snapshot WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM projection.attribute_assertion WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM projection.survivorship_rule WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  }, timeout);

async function seed(subject: string, n: number, attrs = 4) {
  const rows: string[] = [];
  const params: unknown[] = [TENANT, subject];
  let i = 3;
  for (let k = 0; k < n; k += 1) {
    rows.push(`($1::uuid,$2,$${i},$${i + 1},'import',0.5,'unverified','2026-08-01T09:00:00Z')`);
    params.push(`attr_${k % attrs}`, `v${k}`);
    i += 2;
  }
  await dataService.query(
    `INSERT INTO projection.attribute_assertion
       (tenant_id, subject_ref, attribute, value, origin_class, confidence, verification_state, observed_at)
     VALUES ${rows.join(',')}`,
    params,
  );
}

describe('replay is deterministic and idempotent (AC1)', () => {
  maybe('the same log yields the same content hash, every time', async () => {
    const subject = `lead:${randomUUID()}`;
    await seed(subject, 40);

    const a = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    const b = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    const c = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    expect(a.content_hash).toBe(b.content_hash);
    expect(b.content_hash).toBe(c.content_hash);
    // First run has no prior snapshot, so it counts as changed; repeats must not.
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(false);
    expect(c.changed).toBe(false);
  });

  maybe('the hash ignores wall-clock time but reacts to a real change', async () => {
    const subject = `lead:${randomUUID()}`;
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'A', origin_class: 'import' });
    const before = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    // A second, WINNING assertion must change the hash.
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'B', origin_class: 'human_verified' });
    const after = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.changed).toBe(true);
    expect(after.projection.attributes[0].surviving_value).toBe('B');
  });

  maybe('replaying twice leaves ONE snapshot row with an incremented count', async () => {
    const subject = `lead:${randomUUID()}`;
    await seed(subject, 5);
    await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    const rows = await dataService.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection.replay_snapshot
        WHERE tenant_id = $1::uuid AND subject_ref = $2`, [TENANT, subject],
    );
    expect(rows.rows[0].n).toBe('1');
    const snap = await replay.getReplaySnapshot({ tenant_id: TENANT, subject_ref: subject });
    expect(snap!.replay_count).toBe(3);
  });

  maybe('rebuilds from the log rather than patching — deleting the snapshot loses nothing', async () => {
    const subject = `lead:${randomUUID()}`;
    await seed(subject, 12);
    const first = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    // The snapshot is a cache, not a source of truth.
    await dataService.query(
      `DELETE FROM projection.replay_snapshot WHERE tenant_id = $1::uuid AND subject_ref = $2`,
      [TENANT, subject],
    );
    const rebuilt = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    expect(rebuilt.content_hash).toBe(first.content_hash);
  });
});

describe('retraction triggers automatic replay (AC2)', () => {
  maybe('retracting an assertion replays its subject in the same call', async () => {
    const subject = `lead:${randomUUID()}`;
    const winner = await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'WINS', origin_class: 'human_verified' });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'RUNNER_UP', origin_class: 'import' });

    const before = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    expect(before.projection.attributes[0].surviving_value).toBe('WINS');

    const out = await replay.retractAndReplay({
      tenant_id: TENANT, assertion_id: winner.assertion_id, reason: 'identity link retracted',
    });

    expect(out.retracted).toBe(true);
    expect(out.replays).toHaveLength(1);
    expect(out.replays[0].trigger).toBe('retraction');
    // Propagation happened INSIDE the retraction call — no window where the projection
    // still shows a formally withdrawn value.
    expect(out.replays[0].projection.attributes[0].surviving_value).toBe('RUNNER_UP');

    const snap = await replay.getReplaySnapshot({ tenant_id: TENANT, subject_ref: subject });
    expect(snap!.content_hash).toBe(out.replays[0].content_hash);
    expect(snap!.last_trigger).toBe('retraction');
  });

  maybe('supersede records the link and replays', async () => {
    const subject = `lead:${randomUUID()}`;
    const old = await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'email', value: 'old@x.com', origin_class: 'human_verified' });
    const fresh = await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'email', value: 'new@x.com', origin_class: 'import' });

    const out = await replay.supersedeAndReplay({
      tenant_id: TENANT, assertion_id: old.assertion_id, superseded_by: fresh.assertion_id,
    });
    expect(out.superseded).toBe(true);
    expect(out.replays[0].projection.attributes[0].surviving_value).toBe('new@x.com');

    // The superseded row is retained with the link, so it still explains the old answer.
    const rows = await proj.listAssertions({ tenant_id: TENANT, subject_ref: subject, include_retracted: true });
    const superseded = rows.find((r) => r.assertion_id === old.assertion_id)!;
    expect(superseded.superseded_by).toBe(fresh.assertion_id);
    expect(superseded.value).toBe('old@x.com');
  });

  maybe('an assertion cannot supersede itself', async () => {
    const id = randomUUID();
    await expect(replay.supersedeAndReplay({
      tenant_id: TENANT, assertion_id: id, superseded_by: id,
    })).rejects.toThrow(/cannot supersede itself/);
  });

  maybe('retracting an unknown assertion reports it rather than pretending success', async () => {
    const out = await replay.retractAndReplay({ tenant_id: TENANT, assertion_id: randomUUID() });
    expect(out.retracted).toBe(false);
    expect(out.replays).toHaveLength(0);
  });
});

describe('replay evidence is appended to the audit chain (AC3)', () => {
  maybe('a replay writes a regulated ledger entry carrying both hashes', async () => {
    const subject = `lead:${randomUUID()}`;
    await seed(subject, 3);
    const r = await replay.replaySubject({
      tenant_id: TENANT, subject_ref: subject, reason: 'audit evidence check',
    });

    const row = await dataService.one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.entry
        WHERE event_type = 'projection.replay.completed.v1'
          AND subject_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [subject],
    );
    expect(row).not.toBeNull();
    expect(row!.payload.content_hash).toBe(r.content_hash);
    expect(row!.payload.reason).toBe('audit evidence check');
  });

  maybe('a no-op replay is STILL recorded — "it made no difference" is the answer', async () => {
    const subject = `lead:${randomUUID()}`;
    await seed(subject, 2);
    await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });
    await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject });

    const rows = await dataService.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.entry
        WHERE event_type = 'projection.replay.completed.v1' AND subject_id = $1`,
      [subject],
    );
    expect(Number(rows.rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  maybe('a retraction records the retraction itself, not only the replay', async () => {
    const subject = `lead:${randomUUID()}`;
    const a = await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'X', origin_class: 'import' });
    await replay.retractAndReplay({ tenant_id: TENANT, assertion_id: a.assertion_id, reason: 'gdpr erasure' });

    const row = await dataService.one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.entry
        WHERE event_type = 'projection.assertion.retracted.v1' AND subject_id = $1`,
      [a.assertion_id],
    );
    expect(row).not.toBeNull();
    expect(row!.payload.reason).toBe('gdpr erasure');
  });
});

describe('a 10k-assertion subject replays within the request budget (AC4)', () => {
  maybe('10,000 assertions replay inside the budget, twice, with a stable hash', async () => {
    const subject = `lead:${randomUUID()}`;
    // Inserted in chunks so the fixture build itself is not the bottleneck.
    for (let c = 0; c < 10; c += 1) await seed(subject, 1000, 8);

    const count = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection.attribute_assertion
        WHERE tenant_id = $1::uuid AND subject_ref = $2`, [TENANT, subject],
    );
    expect(Number(count!.n)).toBe(10_000);

    const t0 = Date.now();
    const first = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject, trigger: 'backfill' });
    const firstMs = Date.now() - t0;

    const t1 = Date.now();
    const second = await replay.replaySubject({ tenant_id: TENANT, subject_ref: subject, trigger: 'backfill' });
    const secondMs = Date.now() - t1;

    // eslint-disable-next-line no-console
    console.log(`[AC4] 10k-assertion replay: first ${firstMs}ms, second ${secondMs}ms (budget ${REQUEST_BUDGET_MS}ms)`);

    expect(firstMs).toBeLessThan(REQUEST_BUDGET_MS);
    expect(secondMs).toBeLessThan(REQUEST_BUDGET_MS);
    // Determinism must hold at scale too — this is where an unstable sort would show up.
    expect(first.content_hash).toBe(second.content_hash);
    expect(second.changed).toBe(false);
    expect(first.assertion_count).toBe(10_000);
  }, 120_000);
});

describe('tenant-wide replay is bounded and reports what is left', () => {
  maybe('respects the limit and returns remaining rather than sweeping unbounded', async () => {
    const tenant = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await dataService.query(
        `INSERT INTO projection.attribute_assertion (tenant_id, subject_ref, attribute, value, origin_class)
         VALUES ($1::uuid, $2, 'phone', 'v', 'import')`,
        [tenant, `lead:sweep-${i}`],
      );
    }
    const out = await replay.replayTenant({ tenant_id: tenant, limit: 2 });
    expect(out.replayed).toBe(2);
    expect(out.remaining).toBe(3);

    await dataService.query(`DELETE FROM projection.replay_snapshot WHERE tenant_id = $1::uuid`, [tenant]);
    await dataService.query(`DELETE FROM projection.attribute_assertion WHERE tenant_id = $1::uuid`, [tenant]);
  });
});
