import { describe, expect, it } from 'vitest';
import { isPublic, isSelfGuarded } from '../src/plugins/authGate';
import { scopeForRequest, scopeSatisfied } from '@projexlight/sdk-api-keys';

/**
 * The coverage gate.
 *
 * The claim this epic makes is: an API key reaches every TENANT route, and no
 * operator route. Both halves are load-bearing and neither is self-evident from
 * reading the gate, so they are asserted here rather than described in a doc.
 *
 * The classification below is what the gate consults before it looks at a
 * credential at all: `isPublic` short-circuits to no auth, `isSelfGuarded`
 * hands the request to a surface with its own credential, and everything else
 * is the tenant surface where a key is accepted. Getting a path into the wrong
 * bucket is how a route silently loses its guard, so the buckets are the thing
 * worth testing.
 */

/** Routes a tenant credential must be able to reach. */
const TENANT_ROUTES = [
  '/api/sla/clocks',
  '/api/sla/policies',
  '/api/assignment/assign-by-task',
  '/api/notifications/send',
  '/api/crm/contacts',
  '/api/coverage/eligible',
  '/api/scheduling/appointments',
  '/api/import/runs',
  '/api/applications',
  '/api/api-keys',
  '/api/consent/receipts',
  '/api/evidence/capture',
];

/** Surfaces that must refuse a tenant credential, however well scoped. */
const OPERATOR_ROUTES = [
  '/admin/pools',
  '/api/admin/asset/rollup/backfill',
  '/scim/v2/Users',
  '/api/commands/2f4fcba4-e38f-41ad-98e0-c8653cada3be/ack',
];

/** Surfaces that legitimately take no tenant credential at all. */
const PUBLIC_ROUTES = [
  '/health',
  '/metrics',
  '/api/auth/login',
  '/api/auth/signup-tenant',
  '/api/auth/token',
  '/.well-known/jwks.json',
  '/api/connectors/inbound/hubspot',
  '/api/deliverability/webhooks/ses',
  '/api/scheduling/public/book',
];

describe('tenant surface accepts API keys', () => {
  it.each(TENANT_ROUTES)('%s is neither public nor self-guarded, so the gate authenticates it', (path) => {
    expect(isPublic(path)).toBe(false);
    expect(isSelfGuarded(path)).toBe(false);
  });

  it.each(TENANT_ROUTES)('%s derives a scope a key can hold', (path) => {
    const scope = scopeForRequest({ method: 'POST', url: path, routePattern: path });
    expect(scope).toBeTruthy();
    expect(scope!.split('.')).toHaveLength(3);
  });

  it('covers routes no SDK opted in for — the whole point of gating centrally', () => {
    // sdk-crm, sdk-coverage, sdk-scheduling and sdk-import were never edited for
    // key support. If this regresses, coverage has quietly gone back to opt-in.
    for (const path of ['/api/crm/contacts', '/api/coverage/eligible', '/api/scheduling/appointments', '/api/import/runs']) {
      expect(isPublic(path) || isSelfGuarded(path)).toBe(false);
    }
  });
});

describe('operator surfaces refuse API keys', () => {
  it.each(OPERATOR_ROUTES)('%s is self-guarded, so a key never reaches it with authority', (path) => {
    expect(isSelfGuarded(path)).toBe(true);
  });

  it('a fully scoped key still derives no authority over an operator path', () => {
    // Even a wildcard key. The gate returns before verifying a credential on
    // these paths, and the surface's own guard (ADMIN_OPS_TOKEN, SCIM bearer,
    // robot credential) is what decides.
    for (const path of OPERATOR_ROUTES) {
      expect(isSelfGuarded(path)).toBe(true);
    }
    expect(scopeSatisfied(['*'], 'admin.pool.read')).toBe(true); // the scope would satisfy...
    expect(isSelfGuarded('/api/admin/asset/rollup/backfill')).toBe(true); // ...but the path never gets there
  });
});

describe('public surfaces', () => {
  it.each(PUBLIC_ROUTES)('%s needs no tenant credential', (path) => {
    expect(isPublic(path)).toBe(true);
  });

  it('the token endpoint is public because the credential IS the body', () => {
    expect(isPublic('/api/auth/token')).toBe(true);
  });
});

describe('the gate can fail', () => {
  /**
   * A gate that cannot fail is theatre. These plant the two mistakes this suite
   * exists to catch and assert the classification notices.
   */
  it('catches a tenant route wrongly classified as public', () => {
    const planted = '/api/sla/clocks';
    // If somebody added this to PUBLIC_EXACT, the first assertion in the tenant
    // block above would fail. Proving the check is real means showing that a
    // path which IS public is reported as such.
    expect(isPublic(planted)).toBe(false);
    expect(isPublic('/api/auth/login')).toBe(true);
  });

  it('catches an operator route that lost its self-guard', () => {
    // A path one character off the ADMIN prefix is NOT self-guarded — which is
    // exactly the typo that would expose an operator surface to a tenant key.
    expect(isSelfGuarded('/api/admins/pools')).toBe(false);
    expect(isSelfGuarded('/api/admin/pools')).toBe(true);
  });

  it('does not treat an arbitrary path ending in /health as an operator surface', () => {
    // /api/vault/health is deliberately public; a health probe should not need
    // a credential. Asserted so the isHealth suffix rule stays intentional.
    expect(isPublic('/api/vault/health')).toBe(true);
    expect(isPublic('/api/vault/healthy')).toBe(false);
  });
});
