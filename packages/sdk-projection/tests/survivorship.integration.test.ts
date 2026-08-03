import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Survivorship against a REAL Postgres: the precedence resolution, the platform-default
 * seed and the partial unique indexes are all SQL, so a mocked dataService would only
 * prove the mock. Skips itself when no database is reachable.
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
const SUBJECT = `lead:${randomUUID()}`;

let rules: typeof import('../src/services/survivorshipRuleService');
let proj: typeof import('../src/services/explainedProjectionService');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM projection.survivorship_rule LIMIT 1');
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
  rules = await import('../src/services/survivorshipRuleService');
  proj = await import('../src/services/explainedProjectionService');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM projection.attribute_assertion WHERE tenant_id = $1::uuid`, [TENANT]);
  await dataService.query(`DELETE FROM projection.survivorship_rule WHERE tenant_id = $1::uuid`, [TENANT]);
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

async function assert_(o: {
  attribute: string; value: string; origin_class: string;
  confidence?: number; verification_state?: 'unverified' | 'verified' | 'rejected';
  observed_at?: string;
}) {
  return proj.recordAssertion({ tenant_id: TENANT, subject_ref: SUBJECT, ...o });
}

describe('rules are tenant-configurable with a platform default (AC2)', () => {
  maybe('falls back to the platform default when the tenant has no override', async () => {
    const r = await rules.resolveSurvivorshipRules({ tenant_id: TENANT, attribute: 'phone' });
    expect(r.source).toBe('platform');
    expect(r.criteria[0].criterion).toBe('verification_state');
  });

  maybe('a tenant override wins, and the platform row is left intact', async () => {
    await rules.putSurvivorshipRules({
      tenant_id: TENANT,
      attribute: '*',
      criteria: [{ criterion: 'confidence', direction: 'desc' }, { criterion: 'recency', direction: 'desc' }],
      updated_by: 'test',
    });
    const r = await rules.resolveSurvivorshipRules({ tenant_id: TENANT, attribute: 'phone' });
    expect(r.source).toBe('tenant');
    expect(r.criteria[0].criterion).toBe('confidence');

    // The shared platform row must not have been edited by a tenant write.
    const platform = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection.survivorship_rule
        WHERE tenant_id IS NULL AND attribute = '*'`,
    );
    expect(platform!.n).toBe('1');
  });

  maybe('an attribute-specific tenant rule beats the tenant catch-all', async () => {
    await rules.putSurvivorshipRules({
      tenant_id: TENANT, attribute: 'email',
      criteria: [{ criterion: 'recency', direction: 'desc' }],
    });
    const specific = await rules.resolveSurvivorshipRules({ tenant_id: TENANT, attribute: 'email' });
    expect(specific.attribute).toBe('email');
    expect(specific.criteria).toHaveLength(1);
    const catchAll = await rules.resolveSurvivorshipRules({ tenant_id: TENANT, attribute: 'phone' });
    expect(catchAll.attribute).toBe('*');
  });

  maybe('the upsert replaces rather than duplicating', async () => {
    await rules.putSurvivorshipRules({
      tenant_id: TENANT, attribute: 'email',
      criteria: [{ criterion: 'confidence', direction: 'desc' }],
    });
    const row = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM projection.survivorship_rule
        WHERE tenant_id = $1::uuid AND attribute = 'email'`, [TENANT],
    );
    expect(row!.n).toBe('1');
  });

  maybe('a malformed rule set is refused at write time', async () => {
    await expect(rules.putSurvivorshipRules({
      tenant_id: TENANT, criteria: [{ criterion: 'nonsense' } as never],
    })).rejects.toThrow(/invalid survivorship criteria/);

    await expect(rules.putSurvivorshipRules({
      tenant_id: TENANT,
      criteria: [{ criterion: 'confidence' }, { criterion: 'confidence' }] as never,
    })).rejects.toThrow(/can never be reached/);
  });
});

describe('every losing assertion carries a concrete reason (AC1)', () => {
  maybe('names the deciding criterion, both values and its position in the order', async () => {
    // Back to the platform ordering for this subject.
    await rules.deleteSurvivorshipRules({ tenant_id: TENANT, attribute: '*' });
    await rules.deleteSurvivorshipRules({ tenant_id: TENANT, attribute: 'email' });

    await assert_({ attribute: 'phone', value: '+44 111', origin_class: 'import', confidence: 0.9 });
    await assert_({ attribute: 'phone', value: '+44 222', origin_class: 'user_supplied', confidence: 0.5 });

    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: SUBJECT });
    const phone = p.attributes.find((a) => a.attribute === 'phone')!;

    // user_supplied outranks import on the platform order, even at lower confidence.
    expect(phone.surviving_value).toBe('+44 222');
    expect(phone.losing).toHaveLength(1);

    const reason = phone.losing[0].reason;
    expect(reason).toMatch(/origin_class/);
    expect(reason).toMatch(/'import'/);
    expect(reason).toMatch(/'user_supplied'/);
    expect(reason).toMatch(/criterion 2 of 4/);
    // Never a bare status word.
    expect(reason).not.toMatch(/^(superseded|stale|outranked)\.?$/i);
    expect(phone.losing[0].decided_by.criterion).toBe('origin_class');
    expect(phone.losing[0].decided_by.criterion_index).toBe(2);
  });

  maybe('reports confidence losses with the actual numbers', async () => {
    const subject = `lead:${randomUUID()}`;
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'title', value: 'CTO', origin_class: 'import', confidence: 0.9 });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'title', value: 'CEO', origin_class: 'import', confidence: 0.4 });
    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    const t = p.attributes[0];
    expect(t.surviving_value).toBe('CTO');
    expect(t.losing[0].reason).toMatch(/lost on confidence \(criterion 3 of 4\)/);
    expect(t.losing[0].reason).toMatch(/0\.4/);
  });

  maybe('a verified value beats an unverified one before origin is even consulted', async () => {
    const subject = `lead:${randomUUID()}`;
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'email', value: 'a@x.com', origin_class: 'user_supplied', verification_state: 'verified' });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'email', value: 'b@x.com', origin_class: 'human_verified' });
    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(p.attributes[0].surviving_value).toBe('a@x.com');
    expect(p.attributes[0].losing[0].decided_by.criterion).toBe('verification_state');
    expect(p.attributes[0].losing[0].decided_by.criterion_index).toBe(1);
  });

  maybe('an exact tie says so and names the tie-break, rather than pretending it was decided', async () => {
    const subject = `lead:${randomUUID()}`;
    const when = '2026-08-01T09:00:00Z';
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'city', value: 'Leeds', origin_class: 'import', confidence: 0.5, observed_at: when });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'city', value: 'York', origin_class: 'import', confidence: 0.5, observed_at: when });
    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(p.attributes[0].losing[0].reason).toMatch(/tied on every configured criterion/);
    expect(p.attributes[0].losing[0].reason).toMatch(/add a criterion/);
  });
});

describe('losing assertions remain fully queryable (AC3)', () => {
  maybe('losers are ordinary rows, returned by listAssertions', async () => {
    const subject = `lead:${randomUUID()}`;
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'X', origin_class: 'import' });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'Y', origin_class: 'user_supplied' });
    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    const loserId = p.attributes[0].losing[0].assertion.assertion_id;

    const all = await proj.listAssertions({ tenant_id: TENANT, subject_ref: subject });
    expect(all.map((a) => a.assertion_id)).toContain(loserId);
    // Losing changed no column on the row — it is computed on read.
    const row = all.find((a) => a.assertion_id === loserId)!;
    expect(row.retracted_at).toBeNull();
    expect(row.value).toBe('X');
  });

  maybe('retracted assertions are excluded from the contest but still returned', async () => {
    const subject = `lead:${randomUUID()}`;
    const a = await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'OLD', origin_class: 'human_verified' });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'NEW', origin_class: 'import' });
    await proj.retractAssertion({ tenant_id: TENANT, assertion_id: a.assertion_id });

    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    // The retracted human_verified value would otherwise have won.
    expect(p.attributes[0].surviving_value).toBe('NEW');
    expect(p.excluded_count).toBe(1);

    const withRetracted = await proj.listAssertions({ tenant_id: TENANT, subject_ref: subject, include_retracted: true });
    expect(withRetracted.map((x) => x.value)).toContain('OLD');
    // Retraction is a state, not a delete.
    expect(withRetracted.find((x) => x.value === 'OLD')!.retracted_at).not.toBeNull();
  });
});

describe('the explained view is stable for identical inputs (AC4)', () => {
  maybe('repeated projections are byte-identical apart from the timestamp', async () => {
    const subject = `lead:${randomUUID()}`;
    for (let i = 0; i < 6; i += 1) {
      await proj.recordAssertion({
        tenant_id: TENANT, subject_ref: subject, attribute: 'city',
        value: `V${i}`, origin_class: 'import', confidence: 0.5,
        observed_at: '2026-08-01T09:00:00Z',
      });
    }
    const strip = (p: unknown) => JSON.stringify(p).replace(/"projected_at":"[^"]+"/, '');
    const a = strip(await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject }));
    const b = strip(await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject }));
    const c = strip(await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject }));
    // Six assertions tied on every criterion — without the assertion_id tie-break the
    // winner would depend on row order and this would pass only by luck.
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  maybe('attributes come back in a deterministic order', async () => {
    const subject = `lead:${randomUUID()}`;
    for (const attr of ['zeta', 'alpha', 'mid']) {
      await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: attr, value: 'v', origin_class: 'import' });
    }
    const p = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(p.attributes.map((a) => a.attribute)).toEqual(['alpha', 'mid', 'zeta']);
  });

  maybe('a rule change re-explains the SAME rows without touching them', async () => {
    const subject = `lead:${randomUUID()}`;
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'HIGH_CONF_IMPORT', origin_class: 'import', confidence: 0.99 });
    await proj.recordAssertion({ tenant_id: TENANT, subject_ref: subject, attribute: 'phone', value: 'LOW_CONF_USER', origin_class: 'user_supplied', confidence: 0.1 });

    const before = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(before.attributes[0].surviving_value).toBe('LOW_CONF_USER'); // origin beats confidence

    await rules.putSurvivorshipRules({
      tenant_id: TENANT, attribute: 'phone',
      criteria: [{ criterion: 'confidence', direction: 'desc' }],
    });
    const after = await proj.explainProjection({ tenant_id: TENANT, subject_ref: subject });
    expect(after.attributes[0].surviving_value).toBe('HIGH_CONF_IMPORT');
    expect(after.attributes[0].rules.source).toBe('tenant');
    // A rule change is a projection change, never a data migration.
    const rows = await proj.listAssertions({ tenant_id: TENANT, subject_ref: subject });
    expect(rows).toHaveLength(2);
    await rules.deleteSurvivorshipRules({ tenant_id: TENANT, attribute: 'phone' });
  });
});
