import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueKey, shredKey } from '../../src/services/keyService';
import { startChaosCtx, type ChaosCtx } from './setup';

/**
 * AC-2 chaos drill: shredding an encounter key is scoped — sibling encounters
 * of the same persona remain intact.
 */
describe('AC-2 · Encounter key shred is scoped', () => {
  let ctx: ChaosCtx;

  beforeAll(async () => { ctx = await startChaosCtx(); }, 180_000);
  afterAll(async () => { if (ctx) await ctx.stop(); });

  it('only the targeted encounter key is shredded; siblings remain active', async () => {
    const op = { kind: 'service' as const, id: 'test' };
    const root = await issueKey({ tier: 'root', kms_ref: 'kms-r', region: 'us-east-1' }, op);
    const app = await issueKey({ tier: 'app', parent_key_id: root.key_id, kms_ref: 'kms-a', region: 'us-east-1' }, op);
    const pool = await issueKey({ tier: 'pool', parent_key_id: app.key_id, kms_ref: 'kms-p', region: 'us-east-1' }, op);
    const tenant = await issueKey({ tier: 'tenant', parent_key_id: pool.key_id, kms_ref: 'kms-t', region: 'us-east-1' }, op);
    const person = await issueKey({ tier: 'person', parent_key_id: tenant.key_id, kms_ref: 'kms-pe', region: 'us-east-1' }, op);
    const enc1 = await issueKey({ tier: 'encounter', parent_key_id: person.key_id, scope_id: 'enc-1', kms_ref: 'kms-e1', region: 'us-east-1' }, op);
    const enc2 = await issueKey({ tier: 'encounter', parent_key_id: person.key_id, scope_id: 'enc-2', kms_ref: 'kms-e2', region: 'us-east-1' }, op);

    await shredKey(enc1.key_id, op, 'encounter-sealed');

    const enc1Row = await ctx.one<{ state: string; kms_ref: string | null }>(
      `SELECT state, kms_ref FROM vault.key WHERE key_id = $1`,
      [enc1.key_id],
    );
    expect(enc1Row?.state).toBe('shredded');
    expect(enc1Row?.kms_ref).toBeNull();

    const enc2Row = await ctx.one<{ state: string; kms_ref: string | null }>(
      `SELECT state, kms_ref FROM vault.key WHERE key_id = $1`,
      [enc2.key_id],
    );
    expect(enc2Row?.state).toBe('active');
    expect(enc2Row?.kms_ref).toBe('kms-e2');

    // Parent person key untouched.
    const personRow = await ctx.one<{ state: string }>(`SELECT state FROM vault.key WHERE key_id = $1`, [person.key_id]);
    expect(personRow?.state).toBe('active');
  });
});
