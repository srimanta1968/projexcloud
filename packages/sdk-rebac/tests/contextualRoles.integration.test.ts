import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * Contextual roles against a REAL Postgres — the evidence rule and the live-role
 * uniqueness are CHECK constraints and a partial unique index, so they can only be proven
 * here. Skips itself when no database is reachable.
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
const A = randomUUID();
const B = randomUUID();
let svc: typeof import('../src/services/contextualRoleService');

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT trust_state FROM rebac.relationship LIMIT 1');
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
  svc = await import('../src/services/contextualRoleService');
}, 30_000);

afterAll(async () => {
  if (!dbUp) return;
  await dataService.query(`DELETE FROM rebac.relationship WHERE persona_a = $1::uuid OR persona_b = $1::uuid`, [A]);
  await closeAllPools();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    // ctx.skip() reports the case as SKIPPED. A bare `return` reports it as PASSED,
    // which is indistinguishable from the assertions having actually run.
    if (!dbUp) { ctx.skip(); return; }
    await fn();
  });

describe('multiple concurrent roles per pair, independent trust and validity (AC1)', () => {
  maybe('three roles coexist for one pair, each with its own trust and dates', async () => {
    const daughter = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'daughter',
      trust_state: 'CONFIRMED', evidence_refs: ['attestation:1'],
      valid_from: '2020-01-01T00:00:00Z',
    });
    const carer = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'registered_carer',
      trust_state: 'DOCUMENTED', evidence_refs: ['doc:poa-77'],
      valid_from: '2024-06-01T00:00:00Z',
    });
    const billing = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'billing_contact',
      trust_state: 'CANDIDATE',
    });

    expect(daughter.trust_state).toBe('CONFIRMED');
    expect(carer.trust_state).toBe('DOCUMENTED');
    expect(billing.trust_state).toBe('CANDIDATE');

    const live = await svc.listContextualRoles({ persona_a: A, persona_b: B });
    expect(live.map((r) => r.role_label).sort()).toEqual(['billing_contact', 'daughter', 'registered_carer']);
    // Independent validity: each carries its own start date.
    expect(live.find((r) => r.role_label === 'daughter')!.valid_from).toContain('2020-01-01');
    expect(live.find((r) => r.role_label === 'registered_carer')!.valid_from).toContain('2024-06-01');
  });

  maybe('a duplicate LIVE role for the same label is refused', async () => {
    await expect(svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'daughter',
      trust_state: 'CONFIRMED', evidence_refs: ['attestation:2'],
    })).rejects.toThrow();
  });

  maybe('as_of answers what held at a past instant', async () => {
    // The carer role only began in 2024, so it must not appear in a 2021 view.
    const in2021 = await svc.listContextualRoles({ persona_a: A, persona_b: B, as_of: '2021-01-01T00:00:00Z' });
    expect(in2021.map((r) => r.role_label)).toContain('daughter');
    expect(in2021.map((r) => r.role_label)).not.toContain('registered_carer');
  });

  maybe('a persona cannot hold a role to itself', async () => {
    await expect(svc.grantContextualRole({ kind: 'care-team', persona_a: A, persona_b: A }))
      .rejects.toThrow(/cannot hold a contextual role to itself/);
  });
});

describe('closing sets valid_to and never deletes the row (AC2)', () => {
  maybe('a closed role disappears from the live view but remains in provenance', async () => {
    const role = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'temp_delegate',
      trust_state: 'CANDIDATE',
    });
    const closed = await svc.closeContextualRole({
      relationship_id: role.relationship_id, reason: 'delegation ended',
    });

    expect(closed!.valid_to).not.toBeNull();
    expect(closed!.closed_reason).toBe('delegation ended');

    const live = await svc.listContextualRoles({ persona_a: A, persona_b: B });
    expect(live.map((r) => r.role_label)).not.toContain('temp_delegate');

    // The row itself still exists — this is the question asked when something went wrong.
    const withHistory = await svc.listContextualRoles({ persona_a: A, persona_b: B, include_closed: true });
    expect(withHistory.map((r) => r.role_label)).toContain('temp_delegate');

    const raw = await dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM rebac.relationship WHERE relationship_id = $1::uuid`,
      [role.relationship_id],
    );
    expect(raw!.n).toBe('1');
  });

  maybe('closing is idempotent and does not rewrite the original close date', async () => {
    const role = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'idem_role',
    });
    const first = await svc.closeContextualRole({ relationship_id: role.relationship_id, reason: 'first' });
    const second = await svc.closeContextualRole({ relationship_id: role.relationship_id, reason: 'second' });
    // A retry or a double-click must not move when the role actually stopped being true.
    expect(second!.valid_to).toBe(first!.valid_to);
    expect(second!.closed_reason).toBe('first');
  });

  maybe('closing frees the label so the role can be re-granted later', async () => {
    const again = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: B, role_label: 'temp_delegate',
      trust_state: 'CANDIDATE',
    });
    expect(again.valid_to).toBeNull();
    // Both the closed and the new row now exist for the same label.
    const all = await svc.listContextualRoles({
      persona_a: A, persona_b: B, role_label: 'temp_delegate', include_closed: true,
    });
    expect(all).toHaveLength(2);
  });

  maybe('closing an unknown relationship returns null rather than throwing', async () => {
    expect(await svc.closeContextualRole({ relationship_id: randomUUID() })).toBeNull();
  });
});

describe('evidence is required for CONFIRMED and DOCUMENTED (AC3)', () => {
  maybe('CONFIRMED without evidence is refused with a reason', async () => {
    await expect(svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: randomUUID(),
      role_label: 'unevidenced', trust_state: 'CONFIRMED',
    })).rejects.toThrow(/requires at least one evidence_ref/);
  });

  maybe('DOCUMENTED without evidence is refused', async () => {
    await expect(svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: randomUUID(),
      role_label: 'unevidenced2', trust_state: 'DOCUMENTED', evidence_refs: ['   '],
    })).rejects.toThrow(/requires at least one evidence_ref/);
  });

  maybe('CANDIDATE needs none', async () => {
    const r = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: randomUUID(), role_label: 'guess',
      trust_state: 'CANDIDATE',
    });
    expect(r.evidence_refs).toEqual([]);
  });

  maybe('the CHECK constraint blocks it even when the service is bypassed', async () => {
    // A service-layer check alone would be defeated by a backfill or a direct insert.
    await expect(dataService.query(
      `INSERT INTO rebac.relationship (kind, persona_a, persona_b, role_label, trust_state, evidence_refs)
       VALUES ('care-team', $1::uuid, $2::uuid, 'sneaky', 'CONFIRMED', '{}'::text[])`,
      [A, randomUUID()],
    )).rejects.toThrow(/rel_evidence_required/);
  });

  maybe('promotion to CONFIRMED requires evidence in the same call', async () => {
    const r = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: randomUUID(), role_label: 'to_promote',
    });
    // Promoting first and attaching evidence later would leave a window in which an
    // unevidenced CONFIRMED role exists — the exact state the rule exists to prevent.
    await expect(svc.attestContextualRole({
      relationship_id: r.relationship_id, trust_state: 'CONFIRMED',
    })).rejects.toThrow(/requires at least one evidence_ref/);

    const promoted = await svc.attestContextualRole({
      relationship_id: r.relationship_id, trust_state: 'CONFIRMED',
      evidence_refs: ['attestation:9'],
    });
    expect(promoted!.trust_state).toBe('CONFIRMED');
    expect(promoted!.evidence_refs).toContain('attestation:9');
  });

  maybe('attesting merges evidence rather than replacing it', async () => {
    const r = await svc.grantContextualRole({
      kind: 'care-team', persona_a: A, persona_b: randomUUID(), role_label: 'merge_ev',
      trust_state: 'DOCUMENTED', evidence_refs: ['doc:a'],
    });
    const after = await svc.attestContextualRole({
      relationship_id: r.relationship_id, trust_state: 'CONFIRMED', evidence_refs: ['doc:b'],
    });
    expect(after!.evidence_refs.sort()).toEqual(['doc:a', 'doc:b']);
  });
});

describe('existing relationship rows are unaffected (AC4)', () => {
  maybe('a legacy insert with no new columns still works and defaults safely', async () => {
    const p = randomUUID();
    const row = await dataService.one<{ trust_state: string; valid_to: Date | null; role_label: string | null }>(
      `INSERT INTO rebac.relationship (kind, persona_a, persona_b)
       VALUES ('legacy-kind', $1::uuid, $2::uuid)
       RETURNING trust_state, valid_to, role_label`,
      [A, p],
    );
    // CANDIDATE is the default precisely because it is the only state needing no
    // evidence — any other default would have invalidated every pre-existing row.
    expect(row!.trust_state).toBe('CANDIDATE');
    expect(row!.valid_to).toBeNull();
    expect(row!.role_label).toBeNull();
  });

  maybe('duplicate UNLABELLED edges are still permitted, as before', async () => {
    const p = randomUUID();
    // The original table allows several edges of one kind between two personas; the new
    // unique index is scoped to labelled rows so that behaviour is preserved.
    await dataService.query(
      `INSERT INTO rebac.relationship (kind, persona_a, persona_b) VALUES ('legacy-dup', $1::uuid, $2::uuid)`,
      [A, p],
    );
    await expect(dataService.query(
      `INSERT INTO rebac.relationship (kind, persona_a, persona_b) VALUES ('legacy-dup', $1::uuid, $2::uuid)`,
      [A, p],
    )).resolves.toBeDefined();
  });
});
