/**
 * Tenant-scoped event type registration (TK-4144).
 *
 * The defect these cover is a silent one: EVENT_TYPE_REGISTRY was a
 * compile-time constant with no write path, so a consuming app's first
 * `POST /api/audit/append` 400'd forever — and because the emit path is
 * non-throwing by design, a permanent rejection looked exactly like a
 * transient blip. Apps reported governed actions as recorded while their chain
 * stayed empty, and an empty chain VERIFIES CLEAN.
 *
 * The pure cases (naming convention, baseline-first resolution) always run.
 * The rest opt in with AUDIT_IT=1 and a reachable Postgres, because tenant
 * resolution, additive-only registration and tenant isolation are database
 * guarantees — asserting them against a mock would assert nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';
import { EVENT_TYPE_REGISTRY, validateEventTypeName, assertRegisteredEventType } from '@projexlight/contracts';
import {
  assertResolvableEventType,
  clearEventTypeCache,
  EventTypeRegistrationError,
  listEventTypes,
  registerTenantEventType,
  resolveEventType,
} from '../src/services/eventTypeRegistry';
import { appendAuditEntry } from '../src/services/auditService';
import { verifyChain } from '../src/services/chainVerifier';

describe('event type naming convention', () => {
  it('accepts every one of the platform baseline types', () => {
    const names = Object.keys(EVENT_TYPE_REGISTRY);
    // Guards the convention against the registry rather than against a sample:
    // a pattern that rejected existing platform types would reject valid work.
    expect(names.length).toBeGreaterThan(200);
    expect(names.filter((n) => validateEventTypeName(n) !== null)).toEqual([]);
  });

  it('rejects a name with no version suffix and says what the convention is', () => {
    // The exact name LeadFlow tried. 0 of its 32 names carried a suffix.
    const reason = validateEventTypeName('capture.created');
    expect(reason).toBeTruthy();
    expect(reason).toContain('<domain>.<entity>.<verb>.v<N>');
    // The REASON matters as much as the rule — an author told only "invalid"
    // appends a .v1 and never learns what it is for.
    expect(reason).toContain('new version');
  });

  it('rejects uppercase, spaces, a single segment and a zero version', () => {
    expect(validateEventTypeName('Capture.Created.v1')).toBeTruthy();
    expect(validateEventTypeName('capture created.v1')).toBeTruthy();
    expect(validateEventTypeName('capture.v1')).toBeTruthy();
    expect(validateEventTypeName('capture.created.v0')).toBeTruthy();
    expect(validateEventTypeName('')).toBeTruthy();
  });

  it('accepts the underscore and hyphen forms already in the baseline', () => {
    expect(validateEventTypeName('ai_gateway.tenant_credential.bound.v1')).toBeNull();
    expect(validateEventTypeName('tenant.role-template.updated.v1')).toBeNull();
    expect(validateEventTypeName('capture.lead.created.v12')).toBeNull();
  });
});

describe('baseline resolution needs no tenant and no database', () => {
  it('resolves a platform type with a null tenant', async () => {
    const resolved = await resolveEventType('vault.key.issued.v1', null);
    expect(resolved?.source).toBe('platform');
    expect(resolved?.meta.retention_class).toBe('regulated');
  });

  it('still rejects a type in neither place — OC-2 is intact', async () => {
    await expect(assertResolvableEventType('made.up.event.v1', null)).rejects.toThrow(
      /Unregistered event_type/,
    );
  });

  it('leaves assertRegisteredEventType governing platform code unchanged', () => {
    expect(() => assertRegisteredEventType('vault.key.issued.v1')).not.toThrow();
    expect(() => assertRegisteredEventType('capture.lead.created.v1')).toThrow(/Unregistered event_type/);
  });
});

const RUN_IT = process.env.AUDIT_IT === '1';
const suite = RUN_IT ? describe : describe.skip;

suite('tenant-scoped registration against Postgres', () => {
  const TENANT_A = crypto.randomUUID();
  const TENANT_B = crypto.randomUUID();
  const POOL = `event-registry-probe-${Date.now()}`;
  const TYPE = 'capture.lead.created.v1';

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
    });
    clearEventTypeCache();
  });

  afterAll(async () => {
    // Rows are addressed by a per-run tenant UUID, so nothing else is touched.
    await dataService.query(`DELETE FROM audit.tenant_event_type WHERE tenant_id = ANY($1::uuid[])`, [
      [TENANT_A, TENANT_B],
    ]);
    await closeAllPools();
  });

  it('registers a type and returns created:true with the stored metadata', async () => {
    const result = await registerTenantEventType({
      tenant_id: TENANT_A,
      event_type: TYPE,
      retention_class: 'regulated',
      conflict_policy: 'event-sourcing',
    });
    expect(result.created).toBe(true);
    expect(result.meta).toMatchObject({
      event_type: TYPE,
      retention_class: 'regulated',
      conflict_policy: 'event-sourcing',
      schema_state: 'active',
      compaction_policy: 'none',
      schema_version: 1,
    });
  });

  it('accepts an append of that type — the whole point of the task', async () => {
    // Before this change the identical call returned
    // 400 UnregisteredEventType and the chain stayed empty.
    const entry = await appendAuditEntry({
      pool_index: POOL,
      event_type: TYPE,
      tenant_id: TENANT_A,
      actor_kind: 'human',
      actor_id: 'persona-1',
      payload: { lead_id: 'L-1' },
    });
    // seq arrives as a string: BIGINT comes back from pg unparsed, which is why
    // the controller casts it before replying.
    expect(Number(entry.seq)).toBe(1);
    expect(entry.event_type).toBe(TYPE);
  });

  it('names the registration endpoint in the rejection, not a contracts file', async () => {
    // The old message ("Add it to EVENT_TYPE_REGISTRY first") was actionable
    // only for someone with commit access to the platform. Asserted with a
    // tenant present, so the resolver reaches the database — with no pool
    // registered this surfaces a CONNECTION error instead, which is correct:
    // a transient outage must not be reported as a permanent contract rejection.
    await expect(assertResolvableEventType('made.up.event.v1', TENANT_B)).rejects.toThrow(
      /POST \/api\/events\/types/,
    );
  });

  it("applies the registered type's retention rather than defaulting to operational", async () => {
    // A `regulated` type silently stored as `operational` would be shredded at
    // 90 days instead of 7 years — a quiet compliance failure, not an error.
    const row = await dataService.one<{ retention_class: string }>(
      `SELECT retention_class FROM audit.entry WHERE pool_index = $1 AND seq = 1`,
      [POOL],
    );
    expect(row?.retention_class).toBe('regulated');
  });

  it('verifies a chain that now has entries in it', async () => {
    await appendAuditEntry({
      pool_index: POOL, event_type: TYPE, tenant_id: TENANT_A,
      actor_kind: 'human', actor_id: 'persona-1', payload: { lead_id: 'L-2' },
    });
    const result = await verifyChain({ pool_index: POOL });
    expect(result.ok).toBe(true);
    // The assertion that carries the information: before the fix this same call
    // returned ok over an EMPTY chain, so a green result meant nothing.
    expect(result.entries_checked).toBeGreaterThanOrEqual(2);
  });

  it('keeps one tenant\'s vocabulary invisible to another', async () => {
    expect(await resolveEventType(TYPE, TENANT_B)).toBeNull();
    await expect(
      appendAuditEntry({
        pool_index: `${POOL}-b`, event_type: TYPE, tenant_id: TENANT_B,
        actor_kind: 'human', actor_id: 'persona-2', payload: {},
      }),
    ).rejects.toThrow(/Unregistered event_type/);
  });

  it('refuses to let a tenant shadow a platform baseline type', async () => {
    // The dangerous case: redefining tenant.created.v1 with a shorter retention
    // would change what the platform's own entries mean for that tenant.
    await expect(
      registerTenantEventType({
        tenant_id: TENANT_A,
        event_type: 'tenant.created.v1',
        retention_class: 'transient',
        conflict_policy: 'lww',
      }),
    ).rejects.toThrow(/platform baseline type/);
  });

  it('rejects a malformed name at REGISTRATION, not at append time', async () => {
    await expect(
      registerTenantEventType({
        tenant_id: TENANT_A,
        event_type: 'capture.created',
        retention_class: 'operational',
        conflict_policy: 'lww',
      }),
    ).rejects.toThrow(/<domain>\.<entity>\.<verb>\.v<N>/);
  });

  it('rejects an invalid retention_class and conflict_policy together', async () => {
    const err = await registerTenantEventType({
      tenant_id: TENANT_A,
      event_type: 'capture.lead.scored.v1',
      retention_class: 'forever' as never,
      conflict_policy: 'whatever' as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EventTypeRegistrationError);
    // Both problems in one response — a caller fixing one at a time is a caller
    // deploying twice.
    expect((err as EventTypeRegistrationError).errors).toHaveLength(2);
  });

  it('is additive: re-registering returns the STORED metadata, not the resent one', async () => {
    // A boot-time provisioner re-runs on every deploy. If a second call could
    // overwrite retention_class, one typo in a later release would silently
    // change the regulatory class of everything already written.
    const again = await registerTenantEventType({
      tenant_id: TENANT_A,
      event_type: TYPE,
      retention_class: 'transient',
      conflict_policy: 'lww',
    });
    expect(again.created).toBe(false);
    expect(again.meta.retention_class).toBe('regulated');
    expect(again.meta.conflict_policy).toBe('event-sourcing');
  });

  it('blocks UPDATE at the database level, not only in the service', async () => {
    await expect(
      dataService.query(
        `UPDATE audit.tenant_event_type SET retention_class = 'transient'
          WHERE tenant_id = $1::uuid AND event_type = $2`,
        [TENANT_A, TYPE],
      ),
    ).rejects.toThrow(/additive-only/);
  });

  it('lists the baseline and the tenant\'s own types separately', async () => {
    const listed = await listEventTypes(TENANT_A);
    expect(listed.platform.length).toBe(Object.keys(EVENT_TYPE_REGISTRY).length);
    expect(listed.tenant.map((t) => t.event_type)).toContain(TYPE);

    const forB = await listEventTypes(TENANT_B);
    expect(forB.tenant).toEqual([]);
  });

  it('makes a registration usable on the very next append, with no cache delay', async () => {
    const fresh = 'capture.lead.promoted.v1';
    // A miss must never be cached, or a provisioner that registers then
    // immediately emits would fail for the length of a TTL.
    expect(await resolveEventType(fresh, TENANT_A)).toBeNull();
    await registerTenantEventType({
      tenant_id: TENANT_A, event_type: fresh,
      retention_class: 'operational', conflict_policy: 'lww',
    });
    const entry = await appendAuditEntry({
      pool_index: POOL, event_type: fresh, tenant_id: TENANT_A,
      actor_kind: 'human', actor_id: 'persona-1', payload: {},
    });
    expect(entry.event_type).toBe(fresh);
  });
});
