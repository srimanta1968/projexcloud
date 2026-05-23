/**
 * Prod-blocker #6 integration test: validate that data_rights.person_pool_residency
 * correctly handles BOTH tenant-scoped (NOT NULL tenant_id) and platform-
 * scoped (NULL tenant_id) residency rows after the 002 migration.
 *
 * The old (001-only) UNIQUE constraint collapsed every NULL-tenant row for
 * the same (person, pool) into one row across the entire fleet. The 002
 * fix introduced two partial indexes; this test pins their semantics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChaosCtx, type ChaosCtx } from '../../../sdk-vault/tests/chaos/setup';
import { touchResidency } from '../../src/services/dataRightsService';

const PERSON_A = '11111111-1111-1111-1111-111111111111';
const PERSON_B = '22222222-2222-2222-2222-222222222222';
const TENANT_X = '33333333-3333-3333-3333-333333333333';
const TENANT_Y = '44444444-4444-4444-4444-444444444444';
const POOL_ADMIN = 'admin-us-east-1';
const POOL_DEVICE = 'platform-device';

describe('person_pool_residency partial UNIQUE indexes (Migration 002)', () => {
  let ctx: ChaosCtx;

  beforeAll(async () => { ctx = await startChaosCtx(); }, 180_000);
  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('tenant-scoped: upsert collapses to one row per (person, pool, tenant)', async () => {
    await touchResidency({ person_id: PERSON_A, pool_index: POOL_ADMIN, tenant_id: TENANT_X, data_classes: ['profile'] });
    await touchResidency({ person_id: PERSON_A, pool_index: POOL_ADMIN, tenant_id: TENANT_X, data_classes: ['persona'] });

    const rows = await ctx.rows<{ residency_id: string; data_classes: string[] }>(
      `SELECT residency_id, data_classes FROM data_rights.person_pool_residency
        WHERE person_id = $1 AND pool_index = $2 AND tenant_id = $3`,
      [PERSON_A, POOL_ADMIN, TENANT_X],
    );
    expect(rows).toHaveLength(1);
    // Second touch merges data_classes additively (DISTINCT union).
    expect(rows[0].data_classes.sort()).toEqual(['persona', 'profile']);
  });

  it('different tenants for the same (person, pool) get distinct rows', async () => {
    await touchResidency({ person_id: PERSON_B, pool_index: POOL_ADMIN, tenant_id: TENANT_X, data_classes: ['profile'] });
    await touchResidency({ person_id: PERSON_B, pool_index: POOL_ADMIN, tenant_id: TENANT_Y, data_classes: ['profile'] });

    const rows = await ctx.rows<{ tenant_id: string }>(
      `SELECT tenant_id FROM data_rights.person_pool_residency
        WHERE person_id = $1 AND pool_index = $2 ORDER BY tenant_id`,
      [PERSON_B, POOL_ADMIN],
    );
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_X, TENANT_Y]);
  });

  it('platform-scoped (NULL tenant): upsert collapses to one row per (person, pool)', async () => {
    await touchResidency({ person_id: PERSON_A, pool_index: POOL_DEVICE, tenant_id: null, data_classes: ['device'] });
    await touchResidency({ person_id: PERSON_A, pool_index: POOL_DEVICE, tenant_id: null, data_classes: ['device', 'attestation'] });

    const rows = await ctx.rows<{ residency_id: string; tenant_id: string | null; data_classes: string[] }>(
      `SELECT residency_id, tenant_id, data_classes FROM data_rights.person_pool_residency
        WHERE person_id = $1 AND pool_index = $2 AND tenant_id IS NULL`,
      [PERSON_A, POOL_DEVICE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].data_classes.sort()).toEqual(['attestation', 'device']);
  });

  it('platform-scoped (NULL) coexists with tenant-scoped (NOT NULL) for the same (person, pool)', async () => {
    // PERSON_A already has POOL_ADMIN/TENANT_X (tenant-scoped) AND POOL_DEVICE/NULL
    // from earlier tests. Add a tenant-scoped row in POOL_DEVICE to prove the
    // two partial indexes happily coexist on the same (person, pool).
    await touchResidency({ person_id: PERSON_A, pool_index: POOL_DEVICE, tenant_id: TENANT_X, data_classes: ['device'] });

    const rows = await ctx.rows<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM data_rights.person_pool_residency
        WHERE person_id = $1 AND pool_index = $2
        ORDER BY tenant_id NULLS FIRST`,
      [PERSON_A, POOL_DEVICE],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[1].tenant_id).toBe(TENANT_X);
  });
});
