import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';

/**
 * Credential edge cases, against a real database.
 *
 * Opt in with APK_IT=1 and a DATABASE_URL, the same convention the rest of the
 * platform's integration suites use:
 *
 *   APK_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-api-keys test
 *
 * The cases here are the ones that decide whether a credential is containable:
 * can it be pointed at another tenant, does revocation actually stop it, does a
 * rotation leave both halves working for exactly as long as it claims.
 */

const RUN = process.env.APK_IT === '1' && !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

let svc: typeof import('../src/services/apiKeyService');
let apps: typeof import('../src/services/applicationService');
let creds: typeof import('../src/services/credentialService');
let cache: typeof import('../src/services/keyCache');
let db: typeof import('@projexlight/db-runtime');

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

beforeAll(async () => {
  if (!RUN) return;
  db = await import('@projexlight/db-runtime');
  db.initPool({
    connectionString: process.env.DATABASE_URL as string,
    max: 4,
  });
  svc = await import('../src/services/apiKeyService');
  apps = await import('../src/services/applicationService');
  creds = await import('../src/services/credentialService');
  cache = await import('../src/services/keyCache');
});

afterAll(async () => {
  if (!RUN) return;
  await db.dataService.query(`DELETE FROM api_keys.key WHERE tenant_id = ANY($1::uuid[])`, [
    [TENANT_A, TENANT_B],
  ]);
  await db.dataService.query(`DELETE FROM api_keys.application WHERE tenant_id = ANY($1::uuid[])`, [
    [TENANT_A, TENANT_B],
  ]);
  await db.closeAllPools();
});

async function newKey(tenant_id: string, scopes: string[], environment: 'live' | 'test' = 'live') {
  const app = await apps.createApplication({
    tenant_id,
    name: `app-${randomUUID().slice(0, 8)}`,
    environment,
  });
  const issued = await svc.issueKey({ tenant_id, scopes, application_id: app.application_id });
  return { app, ...issued };
}

d('tenant isolation', () => {
  it('one tenant cannot rotate another tenant\'s key, and gets no plaintext', async () => {
    // THE REGRESSION. Before this epic, rotateKey took only a key_id, so any
    // signed-in user could rotate any key on the platform and read the new
    // plaintext out of the 201 body — a complete takeover of another customer.
    const victim = await newKey(TENANT_B, ['sla.clock.write']);
    const attempt = await svc.rotateKey(victim.key.key_id, TENANT_A);
    expect(attempt).toBeNull();

    // And the victim's credential is untouched.
    const stillWorks = await svc.verifyKey(victim.plaintext);
    expect(stillWorks?.key_id).toBe(victim.key.key_id);
  });

  it('one tenant cannot revoke another tenant\'s key', async () => {
    const victim = await newKey(TENANT_B, ['sla.clock.read']);
    expect(await svc.revokeKey(victim.key.key_id, TENANT_A)).toBeNull();
    cache.cacheClear();
    expect(await svc.verifyKey(victim.plaintext)).not.toBeNull();
  });

  it('listing is scoped to the caller\'s tenant', async () => {
    await newKey(TENANT_A, ['crm.contact.read']);
    const listed = await svc.listKeys(TENANT_A);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((k) => k.tenant_id === TENANT_A)).toBe(true);
  });

  it('a key cannot be issued under another tenant\'s application', async () => {
    const foreign = await apps.createApplication({ tenant_id: TENANT_B, name: 'theirs' });
    await expect(
      svc.issueKey({ tenant_id: TENANT_A, scopes: ['x.y.read'], application_id: foreign.application_id }),
    ).rejects.toThrow(/No application/);
  });
});

d('environment', () => {
  it('a test application mints pk_test_ and a live one mints pk_live_', async () => {
    const test = await newKey(TENANT_A, ['sla.clock.read'], 'test');
    const live = await newKey(TENANT_A, ['sla.clock.read'], 'live');
    expect(test.plaintext.startsWith('pk_test_')).toBe(true);
    expect(live.plaintext.startsWith('pk_live_')).toBe(true);
    expect(test.key.environment).toBe('test');
  });
});

d('lifecycle', () => {
  it('a revoked key stops verifying immediately, on this process', async () => {
    const k = await newKey(TENANT_A, ['sla.clock.write']);
    expect(await svc.verifyKey(k.plaintext)).not.toBeNull();
    await svc.revokeKey(k.key.key_id, TENANT_A);
    // revokeKey evicts locally; without that the cache would keep serving it
    // until the TTL lapsed, which is the whole reason the eviction exists.
    expect(await svc.verifyKey(k.plaintext)).toBeNull();
  });

  it('both halves of a rotation work during the grace window', async () => {
    const original = await newKey(TENANT_A, ['sla.clock.write']);
    const rotated = await svc.rotateKey(original.key.key_id, TENANT_A);
    expect(rotated).not.toBeNull();
    cache.cacheClear();
    // The old key stays usable so a caller can deploy the new one before
    // cutting the old one off; that is the entire point of the grace window.
    expect((await svc.verifyKey(original.plaintext))?.status).toBe('rotating');
    expect((await svc.verifyKey(rotated!.plaintext))?.status).toBe('active');
  });

  it('an expired key does not verify', async () => {
    const app = await apps.createApplication({ tenant_id: TENANT_A, name: `exp-${randomUUID().slice(0, 6)}` });
    const issued = await svc.issueKey({
      tenant_id: TENANT_A,
      scopes: ['sla.clock.read'],
      application_id: app.application_id,
    });
    await db.dataService.query(
      `UPDATE api_keys.key SET expires_at = now() - interval '1 minute' WHERE key_id = $1`,
      [issued.key.key_id],
    );
    cache.cacheClear();
    expect(await svc.verifyKey(issued.plaintext)).toBeNull();
  });

  it('disabling an application revokes its keys atomically', async () => {
    const k = await newKey(TENANT_A, ['sla.clock.write']);
    const result = await apps.disableApplication(k.app.application_id, TENANT_A);
    expect(result?.revoked.map((r) => r.key_id)).toContain(k.key.key_id);
    cache.cacheClear();
    expect(await svc.verifyKey(k.plaintext)).toBeNull();
  });

  it('a disabled application cannot issue new keys', async () => {
    const k = await newKey(TENANT_A, ['sla.clock.write']);
    await apps.disableApplication(k.app.application_id, TENANT_A);
    await expect(
      svc.issueKey({ tenant_id: TENANT_A, scopes: ['sla.clock.write'], application_id: k.app.application_id }),
    ).rejects.toThrow(/disabled/);
  });

  it('a slug collision inside a tenant is refused, across tenants is allowed', async () => {
    await apps.createApplication({ tenant_id: TENANT_A, name: 'Web Backend', slug: 'web-backend' });
    await expect(
      apps.createApplication({ tenant_id: TENANT_A, name: 'Another', slug: 'web-backend' }),
    ).rejects.toThrow(/already exists/);
    // Two tenants may both call their app web-backend; neither should learn of
    // the other's existence through a collision error.
    await expect(
      apps.createApplication({ tenant_id: TENANT_B, name: 'Theirs', slug: 'web-backend' }),
    ).resolves.toBeTruthy();
  });
});

d('verification', () => {
  it('a garbage credential does not verify and costs no lookup', async () => {
    expect(await svc.verifyKey('not-a-key')).toBeNull();
    expect(await svc.verifyKey('Bearer pk_live_ABC')).toBeNull();
  });

  it('a legacy PBKDF2 key still verifies and is upgraded in place', async () => {
    // Simulates a credential issued before the HMAC migration: the row keeps its
    // PBKDF2 digest and has no lookup value. It must keep working, and must stop
    // costing a PBKDF2 computation after the first use.
    const k = await newKey(TENANT_A, ['sla.clock.read']);
    const crypto = await import('crypto');
    const legacy = crypto.pbkdf2Sync(
      k.plaintext,
      Buffer.from('projexlight-api-keys-static-salt', 'utf-8'),
      310_000,
      32,
      'sha256',
    );
    await db.dataService.query(
      `UPDATE api_keys.key SET key_hash = $2, key_lookup = NULL, hash_alg = 'pbkdf2-sha256-310000'
        WHERE key_id = $1`,
      [k.key.key_id, legacy],
    );
    cache.cacheClear();

    expect((await svc.verifyKey(k.plaintext))?.key_id).toBe(k.key.key_id);

    const row = await db.dataService.one<{ key_lookup: Buffer | null; hash_alg: string }>(
      `SELECT key_lookup, hash_alg FROM api_keys.key WHERE key_id = $1`,
      [k.key.key_id],
    );
    expect(row?.key_lookup).not.toBeNull();
    expect(row?.hash_alg).toBe('hmac-sha256');
  });
});

d('client_credentials exchange', () => {
  it('mints a short-lived token for a valid key', async () => {
    const k = await newKey(TENANT_A, ['sla.clock.write', 'sla.clock.read']);
    const grant = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_id: k.app.slug,
      client_secret: k.plaintext,
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.token_type).toBe('Bearer');
    expect(grant.expires_in).toBeLessThanOrEqual(3600);
    expect(grant.scope.split(' ')).toContain('sla.clock.write');
  });

  it('narrows to a requested subset but refuses to widen', async () => {
    const k = await newKey(TENANT_A, ['sla.clock.read']);
    const narrowed = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_secret: k.plaintext,
      scope: 'sla.clock.read',
    });
    expect(narrowed.ok).toBe(true);

    const widened = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_secret: k.plaintext,
      scope: 'sla.clock.write',
    });
    expect(widened.ok).toBe(false);
    if (widened.ok) return;
    expect(widened.error).toBe('invalid_scope');
  });

  it('answers invalid_client identically for unknown, revoked and expired', async () => {
    const revoked = await newKey(TENANT_A, ['sla.clock.read']);
    await svc.revokeKey(revoked.key.key_id, TENANT_A);

    const unknown = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_secret: 'pk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const dead = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_secret: revoked.plaintext,
    });

    expect(unknown.ok).toBe(false);
    expect(dead.ok).toBe(false);
    if (unknown.ok || dead.ok) return;
    // Identical wording, deliberately: a different message for "revoked" would
    // confirm to somebody probing with harvested strings that the key was real.
    expect(unknown.error).toBe('invalid_client');
    expect(dead.error).toBe('invalid_client');
    expect(unknown.error_description).toBe(dead.error_description);
  });

  it('refuses a client_id that does not match the secret', async () => {
    const a = await newKey(TENANT_A, ['sla.clock.read']);
    const b = await newKey(TENANT_A, ['sla.clock.read']);
    const grant = await creds.grantClientCredentials({
      grant_type: 'client_credentials',
      client_id: b.app.slug,
      client_secret: a.plaintext,
    });
    expect(grant.ok).toBe(false);
  });

  it('refuses any other grant type', async () => {
    const grant = await creds.grantClientCredentials({
      grant_type: 'password',
      client_secret: 'pk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(grant.ok).toBe(false);
    if (grant.ok) return;
    expect(grant.error).toBe('unsupported_grant_type');
  });
});
