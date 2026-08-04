import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { initPool, dataService, closeAllPools } from '@projexlight/db-runtime';

/**
 * sdk-webhook × sdk-audit: a tenant's own event type must be SUBSCRIBABLE, not
 * merely appendable (TK-4145).
 *
 * This belongs in the composition suite rather than in either package's own
 * tests, because it is exactly the failure a per-SDK suite cannot see: both
 * packages were individually correct. sdk-audit resolved event types
 * baseline-then-tenant after TK-4144, while sdk-webhook kept its own OC-2
 * mirror pointed at the compile-time baseline alone. The result was a
 * vocabulary that was open for the ledger and still closed for delivery — a
 * vertical could register capture.lead.created.v1, append it successfully, and
 * then be refused a webhook subscription to the very same type.
 *
 * The refusal lands at SUBSCRIBE time, long before anyone is watching for a
 * missing delivery, and afterwards nothing says "you have no subscription" —
 * an empty deliveries list looks identical to "nothing has happened yet".
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

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const OWN_TYPE = 'capture.lead.created.v1';
const B_ONLY_TYPE = 'billing.dunning.escalated.v1';
const PLATFORM_TYPE = 'webhook.delivery.failed.v1';

let webhook: typeof import('@projexlight/sdk-webhook');
let audit: typeof import('@projexlight/sdk-audit');
let endpointA = '';
let endpointB = '';

beforeAll(async () => {
  try {
    initPool({ primary: PG });
    await dataService.query('SELECT 1 FROM webhook.endpoint LIMIT 1');
    await dataService.query('SELECT 1 FROM audit.tenant_event_type LIMIT 1');
    dbUp = true;
  } catch (err) {
    dbUp = false;
    // Fail loud, per this suite's existing convention: a run that reports green
    // having verified nothing is worse than a red one.
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
  webhook = await import('@projexlight/sdk-webhook');
  audit = await import('@projexlight/sdk-audit');

  // Tenant A registers its own type; tenant B registers a DIFFERENT one, so the
  // isolation case proves scoping rather than merely proving B registered nothing.
  await audit.registerTenantEventType({
    tenant_id: TENANT_A, event_type: OWN_TYPE,
    retention_class: 'regulated', conflict_policy: 'event-sourcing',
  });
  await audit.registerTenantEventType({
    tenant_id: TENANT_B, event_type: B_ONLY_TYPE,
    retention_class: 'operational', conflict_policy: 'lww',
  });

  const a = await webhook.registerEndpoint({
    tenant_id: TENANT_A, url: 'https://example.com/hook-a', signing_key_ref: 'vault:test-key-a',
  });
  const b = await webhook.registerEndpoint({
    tenant_id: TENANT_B, url: 'https://example.com/hook-b', signing_key_ref: 'vault:test-key-b',
  });
  endpointA = a.endpoint_id;
  endpointB = b.endpoint_id;
});

afterAll(async () => {
  if (dbUp) {
    // Addressed by per-run tenant UUIDs, so nothing else is touched.
    await dataService.query(
      'DELETE FROM webhook.subscription WHERE endpoint_id = ANY($1::uuid[])',
      [[endpointA, endpointB].filter(Boolean)],
    );
    await dataService.query('DELETE FROM webhook.endpoint WHERE tenant_id = ANY($1::uuid[])', [
      [TENANT_A, TENANT_B],
    ]);
    await dataService.query('DELETE FROM audit.tenant_event_type WHERE tenant_id = ANY($1::uuid[])', [
      [TENANT_A, TENANT_B],
    ]);
  }
  await closeAllPools();
});

describe('webhook subscription resolves event types baseline-then-tenant', () => {
  it.runIf(!SKIP_DB_TESTS)("subscribes to the tenant's OWN registered type", async () => {
    // Before TK-4145 this threw UnregisteredEventType, even though the identical
    // event_type appended to the ledger without complaint.
    const sub = await webhook.subscribe({
      endpoint_id: endpointA, event_type: OWN_TYPE,
    });
    expect(sub.event_type).toBe(OWN_TYPE);
    expect(sub.active).toBe(true);
  });

  it.runIf(!SKIP_DB_TESTS)('still subscribes to a platform baseline type — no regression', async () => {
    const sub = await webhook.subscribe({
      endpoint_id: endpointA, event_type: PLATFORM_TYPE,
    });
    expect(sub.event_type).toBe(PLATFORM_TYPE);
  });

  it.runIf(!SKIP_DB_TESTS)("refuses another tenant's type on this endpoint", async () => {
    // The scope key is the ENDPOINT's tenant, not the caller's convenience. B has
    // registered a type of its own, so this proves scoping rather than emptiness.
    await expect(
      webhook.subscribe({ endpoint_id: endpointA, event_type: B_ONLY_TYPE }),
    ).rejects.toThrow(/is not registered for this endpoint's tenant/);
    await expect(
      webhook.subscribe({ endpoint_id: endpointB, event_type: OWN_TYPE }),
    ).rejects.toThrow(/is not registered for this endpoint's tenant/);
  });

  it.runIf(!SKIP_DB_TESTS)('still refuses a type in NEITHER place — OC-2 intact', async () => {
    // The guard's purpose is unchanged: a typo here silently drops every delivery.
    const err = await webhook
      .subscribe({ endpoint_id: endpointA, event_type: 'capture.lead.creatd.v1' })
      .catch((e) => e as Error & { code?: string });
    expect(err.code).toBe('UnregisteredEventType');
    // The message must name something the caller can act on. The old text pointed
    // at EVENT_TYPE_REGISTRY — a constant a tenant-app author cannot reach.
    expect(err.message).toMatch(/POST \/api\/events\/types/);
    expect(err.message).not.toMatch(/EVENT_TYPE_REGISTRY/);
  });

  it.runIf(!SKIP_DB_TESTS)('reports EndpointNotFound ahead of an unregistered type', async () => {
    // Documented precedence change: the endpoint is looked up first because its
    // tenant is what the type is resolved against. Asserted so the reorder is a
    // decision on record rather than an accident someone re-flips later.
    const err = await webhook
      .subscribe({ endpoint_id: randomUUID(), event_type: 'still.not.real.v1' })
      .catch((e) => e as Error & { code?: string });
    expect(err.code).toBe('EndpointNotFound');
  });

  it.runIf(!SKIP_DB_TESTS)('leaves fan-out tenant-scoped', async () => {
    // The delivery path already filtered on the endpoint's tenant, so this change
    // needed nothing downstream — asserted rather than assumed, because a
    // subscription that fans out across tenants would leak one tenant's events
    // into another's endpoint.
    const rows = await dataService.rows<{ tenant_id: string }>(
      `SELECT e.tenant_id
         FROM webhook.subscription s
         JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
        WHERE s.event_type = $1 AND s.active = TRUE AND e.tenant_id = $2`,
      [OWN_TYPE, TENANT_A],
    );
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
  });
});
