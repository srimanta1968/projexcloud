import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Frequency caps and the no-answer dedup window, against a REAL Postgres — the dedup
 * guarantee is a partial unique index and an ON CONFLICT, so it cannot be proven anywhere
 * else. Skips itself when no database is reachable.
 */

const PG = {
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5432),
  database: process.env.TEST_PGDATABASE || 'projexcloud_db',
  user: process.env.TEST_PGUSER || 'postgres',
  password: process.env.TEST_PGPASSWORD || 'postgres',
};

// Explicit opt-out. Unset (the CI default) means an unreachable database FAILS this
// suite rather than quietly passing it. See the catch block below.
const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === '1';
let dbUp = false;
const TENANT = randomUUID();
let cap: typeof import('../src/services/frequencyCap');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM notification.frequency_policy LIMIT 1');
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
  cap = await import('../src/services/frequencyCap');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM notification.send_ledger WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM notification.frequency_policy WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

describe('cap and window are tenant-configurable (AC1)', () => {
  maybe('the platform default is UNCAPPED, so an upgrade cannot start dropping traffic', async () => {
    const p = await cap.resolveFrequencyPolicy({ tenant_id: TENANT, channel: 'sms' });
    expect(p.source).toBe('platform');
    expect(p.max_per_day).toBeNull();
    expect(p.dedup_window_seconds).toBe(900);
  });

  maybe('a tenant policy overrides the default and the platform row is untouched', async () => {
    await cap.setFrequencyPolicy({
      tenant_id: TENANT, channel: 'sms', purpose: 'marketing',
      max_per_day: 2, dedup_window_seconds: 60, updated_by: 'test',
    });
    const p = await cap.resolveFrequencyPolicy({ tenant_id: TENANT, channel: 'sms', purpose: 'marketing' });
    expect(p.source).toBe('tenant');
    expect(p.max_per_day).toBe(2);

    const platform = await dataService.one<{ max_per_day: number | null }>(
      `SELECT max_per_day FROM notification.frequency_policy
        WHERE tenant_id IS NULL AND channel='*' AND purpose='*'`,
    );
    expect(platform!.max_per_day).toBeNull();
  });

  maybe('null max_per_day means uncapped and is NOT the same as 0', async () => {
    await cap.setFrequencyPolicy({ tenant_id: TENANT, channel: 'push', purpose: 'blocked', max_per_day: 0 });
    const zero = await cap.resolveFrequencyPolicy({ tenant_id: TENANT, channel: 'push', purpose: 'blocked' });
    expect(zero.max_per_day).toBe(0);

    const d = await cap.reserveSend({ tenant_id: TENANT, channel: 'push', purpose: 'blocked', destination: 'dev-1' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.blocked_by).toBe('cap');
  });

  maybe('a nonsensical policy is refused', async () => {
    await expect(cap.setFrequencyPolicy({ tenant_id: TENANT, max_per_day: -1 }))
      .rejects.toThrow(/max_per_day must be/);
    await expect(cap.setFrequencyPolicy({ tenant_id: TENANT, dedup_window_seconds: 999_999 }))
      .rejects.toThrow(/dedup_window_seconds must be/);
  });
});

describe('a retry inside the dedup window produces no duplicate send (AC2)', () => {
  maybe('the second identical send is suppressed, not delivered', async () => {
    const dest = `+4477${Math.floor(Math.random() * 10_000_000)}`;
    const args = {
      tenant_id: TENANT, channel: 'sms', purpose: 'no_answer',
      destination: dest, body: 'We tried to reach you', auto_dedup: true,
    };
    const first = await cap.reserveSend(args);
    const second = await cap.reserveSend(args);
    const third = await cap.reserveSend(args);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(third.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.blocked_by).toBe('dedup');
      expect(second.reason).toMatch(/retry of the same message, not a second send/);
    }

    // Exactly ONE ledger row actually sent — no duplicate burst.
    const rows = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification.send_ledger
        WHERE tenant_id = $1::uuid AND destination = $2 AND outcome = 'sent'`,
      [TENANT, dest],
    );
    expect(rows!.n).toBe('1');
  });

  maybe('CONCURRENT retries cannot both win — the insert is the check', async () => {
    const dest = `+4478${Math.floor(Math.random() * 10_000_000)}`;
    const args = {
      tenant_id: TENANT, channel: 'sms', purpose: 'no_answer',
      destination: dest, body: 'burst', auto_dedup: true,
    };
    // A read-then-write check would let several of these through.
    const results = await Promise.all(Array.from({ length: 8 }, () => cap.reserveSend(args)));
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => !r.allowed)).toHaveLength(7);
  });

  maybe('a DIFFERENT body to the same recipient is a different send', async () => {
    const dest = `+4479${Math.floor(Math.random() * 10_000_000)}`;
    const a = await cap.reserveSend({ tenant_id: TENANT, channel: 'sms', purpose: 'no_answer', destination: dest, body: 'first', auto_dedup: true });
    const b = await cap.reserveSend({ tenant_id: TENANT, channel: 'sms', purpose: 'no_answer', destination: dest, body: 'second', auto_dedup: true });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  maybe('omitting dedup opts out entirely — repeats are allowed', async () => {
    const dest = `+4470${Math.floor(Math.random() * 10_000_000)}`;
    const args = { tenant_id: TENANT, channel: 'email', purpose: 'txn', destination: dest, body: 'x' };
    expect((await cap.reserveSend(args)).allowed).toBe(true);
    expect((await cap.reserveSend(args)).allowed).toBe(true);
  });

  maybe('releasing a failed send frees both the cap unit and the window', async () => {
    const dest = `+4471${Math.floor(Math.random() * 10_000_000)}`;
    const args = { tenant_id: TENANT, channel: 'sms', purpose: 'no_answer', destination: dest, body: 'retryable', auto_dedup: true };
    const first = await cap.reserveSend(args);
    expect(first.allowed).toBe(true);
    if (first.allowed) await cap.releaseSend(first.ledger_id);

    // The retry after a provider failure must go through, not be swallowed as a duplicate.
    const retry = await cap.reserveSend(args);
    expect(retry.allowed).toBe(true);
  });
});

describe('caps are evaluated per channel AND per purpose (AC4)', () => {
  maybe('exhausting one purpose does not block another', async () => {
    await cap.setFrequencyPolicy({ tenant_id: TENANT, channel: 'sms', purpose: 'promo', max_per_day: 1 });
    const promo1 = await cap.reserveSend({ tenant_id: TENANT, channel: 'sms', purpose: 'promo', destination: 'p1' });
    const promo2 = await cap.reserveSend({ tenant_id: TENANT, channel: 'sms', purpose: 'promo', destination: 'p2' });
    expect(promo1.allowed).toBe(true);
    expect(promo2.allowed).toBe(false);

    // An OTP must not be throttled because marketing burned the allowance.
    const otp = await cap.reserveSend({ tenant_id: TENANT, channel: 'sms', purpose: 'otp', destination: 'p3' });
    expect(otp.allowed).toBe(true);
  });

  maybe('exhausting one channel does not block another', async () => {
    await cap.setFrequencyPolicy({ tenant_id: TENANT, channel: 'whatsapp', purpose: 'alerts', max_per_day: 1 });
    expect((await cap.reserveSend({ tenant_id: TENANT, channel: 'whatsapp', purpose: 'alerts', destination: 'w1' })).allowed).toBe(true);
    expect((await cap.reserveSend({ tenant_id: TENANT, channel: 'whatsapp', purpose: 'alerts', destination: 'w2' })).allowed).toBe(false);
    expect((await cap.reserveSend({ tenant_id: TENANT, channel: 'email', purpose: 'alerts', destination: 'e1' })).allowed).toBe(true);
  });

  maybe('a cap denial names the numbers rather than saying "blocked"', async () => {
    const d = await cap.reserveSend({ tenant_id: TENANT, channel: 'whatsapp', purpose: 'alerts', destination: 'w3' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toMatch(/frequency cap reached/);
      expect(d.reason).toMatch(/of 1 automated sends/);
      expect(d.reason).toMatch(/policy source: tenant/);
    }
  });

  maybe('a suppressed retry does NOT consume a cap unit', async () => {
    await cap.setFrequencyPolicy({ tenant_id: TENANT, channel: 'push', purpose: 'nudge', max_per_day: 3, dedup_window_seconds: 300 });
    const args = { tenant_id: TENANT, channel: 'push', purpose: 'nudge', destination: 'dev-x', body: 'same', auto_dedup: true };
    await cap.reserveSend(args);
    for (let i = 0; i < 5; i += 1) await cap.reserveSend(args); // all deduped

    const usage = await cap.getSendUsage({ tenant_id: TENANT, channel: 'push', purpose: 'nudge' });
    // Were retries counted, a retry storm would exhaust the allowance without a single
    // extra message reaching anyone, then block the legitimate sends that follow.
    expect(usage.used_last_24h).toBe(1);
    expect(usage.remaining).toBe(2);
  });
});

describe('existing behaviour is unaffected (AC3)', () => {
  maybe('a caller that opts into nothing is never capped or deduped', async () => {
    await cap.setFrequencyPolicy({ tenant_id: TENANT, channel: 'sms', purpose: '*', max_per_day: 1 });
    const { unifiedDispatch, _resetPreSendGuard } = await import('../src/services/dispatchService');
    _resetPreSendGuard();

    // No purpose, no dedup_key, no respect_frequency_cap → the guard is never reached, so
    // repeated identical dispatches behave exactly as they did before this feature.
    const one = await unifiedDispatch({ tenant_id: TENANT, channel: 'sms', destination: '+15550001', body: 'legacy path' });
    const two = await unifiedDispatch({ tenant_id: TENANT, channel: 'sms', destination: '+15550001', body: 'legacy path' });
    for (const r of [one, two]) {
      expect(r.status).not.toBe('suppressed');
      expect(r.blocked_by).toBeUndefined();
    }

    const ledger = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification.send_ledger
        WHERE tenant_id = $1::uuid AND destination = '+15550001'`, [TENANT],
    );
    // Nothing was written to the ledger either — the legacy path does not touch it at all.
    expect(ledger!.n).toBe('0');
  });

  maybe('opting in on the SAME dispatch call does apply the guard', async () => {
    const { unifiedDispatch } = await import('../src/services/dispatchService');
    const args = {
      tenant_id: TENANT, channel: 'sms' as const, destination: '+15550002',
      body: 'opted in', purpose: 'nudge2', auto_dedup: true,
    };
    await unifiedDispatch(args);
    const second = await unifiedDispatch(args);
    expect(second.status).toBe('suppressed');
    expect(second.blocked_by).toBe('dedup');
  });
});
