/**
 * P5 AC-2 chaos drill: encounter-key shred at seal.
 *
 * Verifies the FR-EN-3 contract end-to-end against real Postgres:
 *   1. openEncounter() issues a per-encounter Vault key parented to a
 *      tenant-tier key, and records key_id on engagement.encounter.vault_key_ref.
 *   2. transitionEncounter(...'sealed') flips vault.key.state to 'shredded',
 *      clears kms_ref, and stamps shredded_at — atomically per the
 *      key_shredded_state CHECK constraint.
 *   3. The shred is captured in vault.key_operation with op='shred'.
 *   4. The seal emits engagement.encounter.sealed.v1 onto the audit chain
 *      with vault_key_shredded:true in the payload.
 *   5. After seal: re-shredding the same key throws (state guard); the
 *      encounter row is now un-decryptable for any ciphertext wrapped
 *      under that key — proven by kms_ref IS NULL on vault.key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startChaosCtx, type ChaosCtx } from '../../../sdk-vault/tests/chaos/setup';
import { issueKey, shredKey } from '@projexlight/sdk-vault';
import { openEncounter, transitionEncounter, getEncounter } from '../../src/services/engagementService';

const REGION = 'us-east-1';
const TENANT = '55555555-5555-5555-5555-555555555555';

/**
 * Seed the minimum vault tier chain (root → app → pool → tenant) needed
 * to parent an encounter-tier key. Chaos DB starts empty; we own the chain.
 */
async function seedVaultChain(): Promise<{ tenantKeyId: string }> {
  const root = await issueKey(
    { tier: 'root', kms_ref: 'kms-root-chaos', region: REGION },
    { kind: 'service', id: 'ac-2.seed' },
  );
  const app = await issueKey(
    { tier: 'app', parent_key_id: root.key_id, kms_ref: 'kms-app-chaos', region: REGION },
    { kind: 'service', id: 'ac-2.seed' },
  );
  const pool = await issueKey(
    { tier: 'pool', parent_key_id: app.key_id, kms_ref: 'kms-pool-chaos', region: REGION },
    { kind: 'service', id: 'ac-2.seed' },
  );
  const tenant = await issueKey(
    { tier: 'tenant', parent_key_id: pool.key_id, kms_ref: 'kms-tenant-chaos', tenant_id: TENANT, region: REGION },
    { kind: 'service', id: 'ac-2.seed' },
  );
  return { tenantKeyId: tenant.key_id };
}

describe('AC-2: per-encounter Vault key shred at seal', () => {
  let ctx: ChaosCtx;
  let tenantKeyId: string;

  beforeAll(async () => {
    ctx = await startChaosCtx();
    const seed = await seedVaultChain();
    tenantKeyId = seed.tenantKeyId;
  }, 180_000);

  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('open → encounter row + encounter-tier vault key with kms_ref set', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'support',
      parent_key_id: tenantKeyId,
      region: REGION,
    });
    expect(enc.state).toBe('open');
    expect(enc.vault_key_ref).toBeTruthy();

    const key = await ctx.one<{ tier: string; state: string; kms_ref: string | null; parent_key_id: string }>(
      `SELECT tier, state, kms_ref, parent_key_id FROM vault.key WHERE key_id = $1`,
      [enc.vault_key_ref!],
    );
    expect(key).not.toBeNull();
    expect(key!.tier).toBe('encounter');
    expect(key!.state).toBe('active');
    expect(key!.kms_ref).not.toBeNull();
    expect(key!.parent_key_id).toBe(tenantKeyId);
  });

  it('seal → vault.key state=shredded + kms_ref NULL + shredded_at stamped', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'visit',
      parent_key_id: tenantKeyId,
      region: REGION,
    });

    const sealed = await transitionEncounter(enc.encounter_id, 'sealed', 'ac-2.test');
    expect(sealed.state).toBe('sealed');
    expect(sealed.sealed_at).toBeTruthy();

    // Post-seal: vault key must be cryptographically shredded.
    const key = await ctx.one<{ state: string; kms_ref: string | null; shredded_at: string | null }>(
      `SELECT state, kms_ref, shredded_at FROM vault.key WHERE key_id = $1`,
      [enc.vault_key_ref!],
    );
    expect(key!.state).toBe('shredded');
    expect(key!.kms_ref).toBeNull(); // FR-EN-3: ciphertext under this key is unrecoverable
    expect(key!.shredded_at).not.toBeNull();
  });

  it('seal emits vault.key_operation op=shred with reason=encounter-sealed', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'deal',
      parent_key_id: tenantKeyId,
      region: REGION,
    });
    await transitionEncounter(enc.encounter_id, 'sealed', 'ac-2.shred-op');

    const ops = await ctx.rows<{ op: string; reason: string | null; operator_id: string }>(
      `SELECT op, reason, operator_id FROM vault.key_operation
        WHERE key_id = $1 ORDER BY occurred_at`,
      [enc.vault_key_ref!],
    );
    // Must include the original issue op + the seal-triggered shred.
    expect(ops.find((o) => o.op === 'issue')).toBeTruthy();
    const shred = ops.find((o) => o.op === 'shred');
    expect(shred).toBeTruthy();
    expect(shred!.reason).toBe('encounter-sealed');
    expect(shred!.operator_id).toBe('ac-2.shred-op');
  });

  it('seal records engagement.encounter.sealed.v1 on audit chain with vault_key_shredded:true', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'session',
      parent_key_id: tenantKeyId,
      region: REGION,
    });
    await transitionEncounter(enc.encounter_id, 'sealed', 'ac-2.audit-check');

    const entries = await ctx.rows<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM audit.entry
        WHERE subject_kind = 'engagement.encounter' AND subject_id = $1
        ORDER BY seq`,
      [enc.encounter_id],
    );
    const sealEntry = entries.find((e) => e.event_type === 'engagement.encounter.sealed.v1');
    expect(sealEntry).toBeTruthy();
    expect(sealEntry!.payload.to).toBe('sealed');
    expect(sealEntry!.payload.vault_key_shredded).toBe(true);
  });

  it('post-seal: re-shredding the same key throws (state guard)', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'support',
      parent_key_id: tenantKeyId,
      region: REGION,
    });
    await transitionEncounter(enc.encounter_id, 'sealed', 'ac-2.guard');

    // Direct vault call must reject — the key is already shredded.
    await expect(
      shredKey(enc.vault_key_ref!, { kind: 'service', id: 'ac-2.guard' }, 'double-shred'),
    ).rejects.toThrow(/already shredded|not found/i);
  });

  it('post-seal: encounter.sealed_at + closed_at are both stamped (idempotent close)', async () => {
    const enc = await openEncounter({
      tenant_id: TENANT,
      kind: 'support',
      parent_key_id: tenantKeyId,
      region: REGION,
    });
    // Skip close — go straight from open to sealed (engagement allows this for instant encounters).
    await transitionEncounter(enc.encounter_id, 'sealed', 'ac-2.fast-seal');

    const got = await getEncounter(enc.encounter_id);
    expect(got!.state).toBe('sealed');
    expect(got!.sealed_at).not.toBeNull();
    expect(got!.closed_at).not.toBeNull(); // engagement back-fills closed_at on direct seal
  });
});
