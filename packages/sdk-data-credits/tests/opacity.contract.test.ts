/**
 * Vendor-opacity contract (P16 · EP-378 · PCF-05-4).
 *
 * The promise: NOTHING a tenant can read names a vendor. Not the provider key, not
 * the credentials reference, not the routing detail, not the true cost we paid.
 *
 * This drives the REAL Fastify routes — every endpoint, every error path — and deep
 * scans each response body for the fixture's vendor strings. It is written as a scan
 * rather than as a list of fields to assert absent, because a field ADDED to a
 * response later is exactly how this boundary gets crossed, and a test that names
 * fields would sail past it. The fixture's provider keys, secret refs and true costs
 * are deliberately distinctive so any substring appearing anywhere in a payload is a
 * leak, whatever it is nested under.
 *
 * Error paths are included on purpose: a message naming the vendor that failed is a
 * leak with a stack trace attached, and it is the leak people forget.
 *
 *   DATA_CREDITS_IT=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/projexcloud_db \
 *     pnpm --filter @projexlight/sdk-data-credits test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeAllPools, dataService, initPool } from '@projexlight/db-runtime';

const TENANT = randomUUID();

/*
 * The route guard is sdk-identity's requireAuth, which wants a real signed tenant JWT.
 * This test is about what the HANDLERS return, not about how they are guarded — the
 * guard itself is exercised against the running gateway — so the credential is stubbed
 * to the tenant this suite created. The stub still populates req.auth exactly as the
 * real one does, so the tenant-scoping logic under test is the real logic.
 */
vi.mock('@projexlight/sdk-identity', () => ({
  requireAuth: async (req: { auth?: { tenant_id: string } }) => {
    req.auth = { tenant_id: TENANT };
  },
}));

const RUN = process.env.DATA_CREDITS_IT === '1';
const suite = RUN ? describe : describe.skip;

const STAMP = Date.now();
const KEY = `find.contact-points-${STAMP}`;
const PRIMARY = `acmedata-${STAMP}`;
const SECONDARY = `globexdata-${STAMP}`;
const SECRET_REF = `secret://platform/${PRIMARY}`;
const TRUE_COST = 771234;

/** Every string a tenant must never see, in the form it would leak as. */
const FORBIDDEN = [
  PRIMARY, SECONDARY, SECRET_REF, 'secret://', String(TRUE_COST),
  'true_cost', 'binding_id', 'provider_key', 'health_state', 'consecutive_failures',
];

let app: FastifyInstance;
let capabilityId: string;

interface Probe { label: string; status: number; body: string }
const probes: Probe[] = [];

async function hit(
  method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({ method, url, payload });
  probes.push({ label: `${method} ${url}`, status: res.statusCode, body: res.body });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body); } catch { /* empty body */ }
  return { status: res.statusCode, json };
}

suite('no tenant-scoped response names a vendor', () => {
  let requestId: string;
  let pendingId: string;
  let reservationId: string;

  beforeAll(async () => {
    initPool({
      connectionString:
        process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/projexcloud_db',
      max: 4,
    });
    const { registerRoutes } = await import('../src/server/routes');
    const { registerProviderInvoker, setSecretResolver } = await import('../src/services/brokerService');
    const { grantCredits } = await import('../src/services/reservationService');

    const [cap] = await dataService.rows<{ capability_id: string }>(
      `INSERT INTO data_credits.capability (key, outcome_label, description, credit_price, category)
       VALUES ($1, 'Find contact points', 'Finds reachable contact points for a subject', 2.0000, 'discovery')
       RETURNING capability_id`,
      [KEY],
    );
    capabilityId = cap.capability_id;
    await dataService.query(
      `INSERT INTO data_credits.provider_binding
          (capability_id, provider_key, secret_ref, priority, true_cost_micros)
       VALUES ($1, $2, $3, 1, $5), ($1, $4, 'secret://platform/secondary', 2, $5)`,
      [capabilityId, PRIMARY, SECRET_REF, SECONDARY, TRUE_COST],
    );
    await grantCredits({ tenant_id: TENANT, credits: 100, reason: 'contract test' });

    setSecretResolver(async (ref) => ({ ref }));
    // The first vendor falls over and the second answers, so every response below is
    // produced by a REAL fallback — the thing that must stay invisible.
    registerProviderInvoker(PRIMARY, async () => {
      throw Object.assign(new Error(`${PRIMARY} refused the connection at ${SECRET_REF}`), {
        code: 'UPSTREAM_REFUSED',
      });
    });
    registerProviderInvoker(SECONDARY, async () => ({
      matched: true, result: { contact_points: ['+15550000000'] }, true_cost_micros: TRUE_COST,
    }));

    app = Fastify({ logger: false });
    await app.register(registerRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (!RUN) return;
    const { clearProviderInvokers, setSecretResolver } = await import('../src/services/brokerService');
    clearProviderInvokers();
    setSecretResolver(null);
    await app?.close();
    await dataService.query(`DELETE FROM data_credits.result_cache WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.budget_policy WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.capability_request WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.credit_account WHERE tenant_id = $1`, [TENANT]);
    await dataService.query(`DELETE FROM data_credits.capability WHERE key = $1`, [KEY]);
    await closeAllPools();
  });

  it('serves the whole surface, success paths included', async () => {
    expect((await hit('GET', '/api/capabilities')).status).toBe(200);
    expect((await hit('GET', `/api/capabilities/estimate?capability_key=${KEY}`)).status).toBe(200);
    expect((await hit('GET', '/api/credits/balance')).status).toBe(200);

    expect((await hit('PUT', '/api/credits/budgets', { role_ref: 'analyst', mode: 'FULL' })).status).toBe(200);
    expect((await hit('GET', '/api/credits/budgets')).status).toBe(200);

    const created = await hit('POST', '/api/capability-requests', {
      capability_key: KEY, subject_fingerprint: `fp-${STAMP}`, role_ref: 'analyst',
    });
    expect(created.status).toBe(201);
    requestId = (created.json.data as { request_id: string }).request_id;

    expect((await hit('GET', '/api/capability-requests?limit=10')).status).toBe(200);
    expect((await hit('GET', `/api/capability-requests/${requestId}`)).status).toBe(200);

    const executed = await hit('POST', `/api/capability-requests/${requestId}/execute`, {
      subject: 'somebody@example.com',
    });
    expect(executed.status).toBe(200);
    // A real fallback happened: the first provider threw, the second answered.
    const data = executed.json.data as { outcome: string; credits_charged: number };
    expect(data.outcome).toBe('MATCHED');
    expect(data.credits_charged).toBe(2);
    const attempts = await dataService.rows<{ outcome: string }>(
      `SELECT outcome FROM data_credits.provider_attempt WHERE request_id = $1 ORDER BY attempt_no`,
      [requestId],
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['TECHNICAL_FAILURE', 'MATCHED']);

    expect((await hit('GET', `/api/credits/ledger?request_id=${requestId}`)).status).toBe(200);

    const reserved = await hit('POST', '/api/credits/reservations', {
      capability_key: KEY, subject_fingerprint: `fp-manual-${STAMP}`, role_ref: 'analyst',
    });
    expect(reserved.status).toBe(201);
    reservationId = (reserved.json.data as { reservation_id: string }).reservation_id;
    expect((await hit('POST', `/api/credits/reservations/${reservationId}/settle`, {
      outcome: 'NO_MATCH',
    })).status).toBe(200);
  });

  it('blocks execute until an approval is granted, and refuses cleanly', async () => {
    expect((await hit('PUT', '/api/credits/budgets', {
      role_ref: 'junior', mode: 'REQUEST_ONLY',
    })).status).toBe(200);

    const pending = await hit('POST', '/api/capability-requests', {
      capability_key: KEY, subject_fingerprint: `fp-pending-${STAMP}`, role_ref: 'junior',
    });
    pendingId = (pending.json.data as { request_id: string; status: string }).request_id;
    expect((pending.json.data as { status: string }).status).toBe('PENDING_APPROVAL');

    const blocked = await hit('POST', `/api/capability-requests/${pendingId}/execute`, { subject: 'x' });
    expect(blocked.status).toBe(409);
    expect((blocked.json as { code: string }).code).toBe('APPROVAL_REQUIRED');
    // Nothing was tried: an unapproved request must not reach a vendor.
    const attempts = await dataService.rows(
      `SELECT 1 FROM data_credits.provider_attempt WHERE request_id = $1`, [pendingId],
    );
    expect(attempts).toHaveLength(0);

    expect((await hit('POST', `/api/capability-requests/${pendingId}/approve`, {
      approved: true, approval_ref: 'apr-contract', decided_by: 'qa',
    })).status).toBe(200);
    expect((await hit('POST', `/api/capability-requests/${pendingId}/execute`, { subject: 'x' })).status)
      .toBe(200);
  });

  it('exports reservation, charge and refund per request', async () => {
    const ledger = await hit('GET', `/api/credits/ledger?request_id=${requestId}`);
    const entries = (ledger.json.data as { entries: Array<{ entry_type: string }> }).entries;
    // Quoted then charged, as two movements — one net number would hide the quote,
    // which is exactly what a disputed invoice asks about.
    expect(entries.map((e) => e.entry_type)).toEqual(['RESERVATION', 'CHARGE']);

    const released = await hit('GET', '/api/credits/ledger?limit=200');
    const all = (released.json.data as { entries: Array<{ entry_type: string; reason: string }> }).entries;
    const release = all.find((e) => e.entry_type === 'RELEASE');
    expect(release, 'a zero settlement must leave a RELEASE entry').toBeTruthy();
    expect(release!.reason).toMatch(/NO_MATCH/);
  });

  it('refuses every error path with a code and no vendor detail', async () => {
    const cases: Array<[Promise<{ status: number; json: Record<string, unknown> }>, number, string]> = [
      [hit('GET', '/api/capabilities/estimate'), 400, 'VALIDATION_ERROR'],
      [hit('GET', '/api/capabilities/estimate?capability_key=validate.nothing'), 404, 'CAPABILITY_NOT_FOUND'],
      [hit('POST', '/api/capability-requests', { subject_fingerprint: 'x' }), 400, 'VALIDATION_ERROR'],
      [hit('POST', '/api/capability-requests', {
        capability_key: 'validate.nothing', subject_fingerprint: 'x',
      }), 404, 'CAPABILITY_NOT_FOUND'],
      [hit('GET', '/api/capability-requests/00000000-0000-4000-8000-0000000000ff'), 404,
        'CAPABILITY_REQUEST_NOT_FOUND'],
      [hit('POST', '/api/credits/reservations/00000000-0000-4000-8000-0000000000ff/settle', {
        outcome: 'NO_MATCH',
      }), 404, 'RESERVATION_NOT_FOUND'],
      [hit('PUT', '/api/credits/budgets', { role_ref: 'x', mode: 'SOMETIMES' }), 400, 'VALIDATION_ERROR'],
      [hit('PUT', '/api/credits/budgets', { role_ref: 'x', mode: 'DAILY_CAP' }), 422, 'VALIDATION_ERROR'],
    ];
    for (const [call, status, code] of cases) {
      const res = await call;
      expect(res.status, JSON.stringify(res.json)).toBe(status);
      expect((res.json as { code: string }).code).toBe(code);
    }

    // A settlement conflict: the reservation was settled NO_MATCH above.
    const conflict = await hit('POST', `/api/credits/reservations/${reservationId}/settle`, {
      outcome: 'MATCHED',
    });
    expect(conflict.status).toBe(409);
    expect((conflict.json as { code: string }).code).toBe('SETTLEMENT_CONFLICT');

    // The one that matters most: the FIRST provider threw an error naming itself and
    // its secret ref. That message must have died in the log, not reached a tenant.
    const failing = await hit('POST', `/api/capability-requests/${pendingId}/execute`, { subject: 'x' });
    expect([200, 409]).toContain(failing.status);
  });

  it('leaked nothing across every response captured above', () => {
    expect(probes.length, 'no responses were captured — the scan would be vacuous').toBeGreaterThan(20);
    const leaks: string[] = [];
    for (const probe of probes) {
      for (const needle of FORBIDDEN) {
        if (probe.body.toLowerCase().includes(needle.toLowerCase())) {
          leaks.push(`${probe.label} [${probe.status}] leaked '${needle}': ${probe.body.slice(0, 200)}`);
        }
      }
    }
    expect(leaks.join('\n')).toBe('');
  });

  it('CAN fail — the scanner catches a planted vendor string', () => {
    // Without this, a scan that silently stopped matching would pass forever while
    // guarding nothing.
    const planted = { data: { result: { served_by: PRIMARY, cost_micros: TRUE_COST } } };
    const body = JSON.stringify(planted);
    const caught = FORBIDDEN.filter((n) => body.toLowerCase().includes(n.toLowerCase()));
    expect(caught.length).toBeGreaterThan(0);
    // And an ordinary tenant-facing body must NOT trip it.
    expect(FORBIDDEN.filter((n) =>
      JSON.stringify({ data: { outcome: 'MATCHED', credits_charged: 2 } })
        .toLowerCase().includes(n.toLowerCase()))).toEqual([]);
  });
});
