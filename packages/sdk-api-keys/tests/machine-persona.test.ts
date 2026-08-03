import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

/**
 * TK-4138 — every API key is anchored to a real machine persona.
 *
 * Same opt-in as the other integration suites here:
 *
 *   APK_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-api-keys test
 *
 * The regression these guard against is silent: api_keys.key had no FK on
 * synthetic_persona_id, so writing a fabricated uuid succeeded and the key looked
 * healthy. Only persona.role_assignment enforced its FK, so the failure surfaced
 * much later as a 23503 during a customer's role grant — 673 keys had already
 * drifted by the time it was noticed. These assert the invariant directly rather
 * than waiting for a downstream symptom.
 */

const RUN = process.env.APK_IT === '1' && !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

let svc: typeof import('../src/services/apiKeyService');
let apps: typeof import('../src/services/applicationService');
let db: typeof import('@projexlight/db-runtime');

const TENANT = randomUUID();

beforeAll(async () => {
  if (!RUN) return;
  db = await import('@projexlight/db-runtime');
  db.initPool({ connectionString: process.env.DATABASE_URL as string, max: 4 });
  svc = await import('../src/services/apiKeyService');
  apps = await import('../src/services/applicationService');
});

afterAll(async () => {
  if (!RUN) return;
  // Keys reference personas with ON DELETE RESTRICT, so keys go first.
  await db.dataService.query(`DELETE FROM api_keys.key WHERE tenant_id = $1`, [TENANT]);
  await db.dataService.query(`DELETE FROM api_keys.application WHERE tenant_id = $1`, [TENANT]);
  await db.dataService.query(
    `DELETE FROM persona.persona p USING persona.membership m
      WHERE p.membership_id = m.membership_id AND m.tenant_id = $1`,
    [TENANT],
  );
  await db.dataService.query(`DELETE FROM persona.membership WHERE tenant_id = $1`, [TENANT]);
});

d('machine personas back every API key', () => {
  it('issues a key whose synthetic_persona_id resolves to a real machine persona', async () => {
    const { key } = await svc.issueKey({ tenant_id: TENANT, scopes: ['sla.clock.read'] } as never);

    const persona = await db.dataService.one<{ kind: string; status: string; membership_id: string }>(
      `SELECT kind, status, membership_id FROM persona.persona WHERE persona_id = $1`,
      [key.synthetic_persona_id],
    );
    expect(persona).toBeTruthy();
    expect(persona!.kind).toBe('machine');
    // membership_id stays NOT NULL so the identity projector needs no null branch.
    expect(persona!.membership_id).toBeTruthy();
  });

  it('gives each key its OWN persona but shares the membership beneath them', async () => {
    const a = await svc.issueKey({ tenant_id: TENANT, scopes: ['sla.clock.read'] } as never);
    const b = await svc.issueKey({ tenant_id: TENANT, scopes: ['sla.clock.read'] } as never);

    // Per-key personas are what let audit and ReBAC tell one credential from another.
    expect(a.key.synthetic_persona_id).not.toBe(b.key.synthetic_persona_id);

    const rows = await db.dataService.rows<{ membership_id: string }>(
      `SELECT membership_id FROM persona.persona WHERE persona_id = ANY($1::uuid[])`,
      [[a.key.synthetic_persona_id, b.key.synthetic_persona_id]],
    );
    expect(rows).toHaveLength(2);
    // ...while L1-L3 stay shared: three rows per tenant+app, not per key.
    expect(rows[0].membership_id).toBe(rows[1].membership_id);
  });

  it('refuses a key that points at a persona which does not exist', async () => {
    // The FK is the whole point: without it this insert silently succeeds and the
    // key only fails months later, during an unrelated role grant.
    await expect(
      db.dataService.query(
        `INSERT INTO api_keys.key
           (tenant_id, prefix, key_hash, key_lookup, hash_alg, synthetic_persona_id, scopes)
         VALUES ($1, 'pk_live_bogus', 'x', 'x', 'hmac-sha256', $2, ARRAY['sla.clock.read'])`,
        [TENANT, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('leaves no key in the whole table without a persona', async () => {
    const orphans = await db.dataService.one<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM api_keys.key k
         LEFT JOIN persona.persona p ON p.persona_id = k.synthetic_persona_id
        WHERE p.persona_id IS NULL`,
    );
    expect(Number(orphans!.n)).toBe(0);
  });
});
