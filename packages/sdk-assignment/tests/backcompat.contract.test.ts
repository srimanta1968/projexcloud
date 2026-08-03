/**
 * assign-by-task is byte-compatible (P16 · EP-379 · PCF-06-4).
 *
 * EP-379 added eleven routes to a package that verticals are ALREADY calling. The
 * promise made to them is that nothing they depend on moved, and the only way to keep
 * a promise like that is to pin it: this test asserts the request shape the old
 * contract accepts and the EXACT KEY SET of the response it returns, so an enhancement
 * that adds a field to the shared result object, renames one, or changes the status
 * code fails here rather than in somebody's integration.
 *
 * It is a contract test, not a behaviour test: the engine is stubbed so the assertion
 * is about the SHAPE crossing the wire, which is what a caller couples to.
 *
 *   ASSIGNMENT_IT is NOT required — this runs everywhere, because a compatibility
 *   guarantee that only holds when a database is reachable is not a guarantee.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TASK = 'task-backcompat-1';
const PERSONA = '22222222-2222-4222-8222-222222222222';

/*
 * The guard and the engine are stubbed at the module boundary. Auth is exercised
 * elsewhere; here it must not decide whether the SHAPE is right.
 */
vi.mock('@projexlight/sdk-api-keys', () => ({
  requireAuthOrApiKeyForDomain: () => async (req: { auth?: { tenant_id: string } }) => {
    req.auth = { tenant_id: TENANT };
  },
}));

const assignByTask = vi.fn();
vi.mock('../src/services/assignmentEngine', () => ({
  assignByTask: (...args: unknown[]) => assignByTask(...args),
}));
vi.mock('../src/services/workloadService', () => ({ setWorkload: vi.fn() }));
// The EP-379 services are imported by the route file; they must not touch a database
// while this test asserts the OLD contract.
vi.mock('../src/services/routingService', () => ({
  activateRuleSet: vi.fn(), getDecision: vi.fn(), listDecisions: vi.fn(),
  listRuleSetVersions: vi.fn(), publishRuleSet: vi.fn(), route: vi.fn(),
  RuleSetNotFound: class RuleSetNotFound extends Error {},
}));
vi.mock('../src/services/lifecycleService', () => ({
  accept: vi.fn(), decline: vi.fn(), getAssignment: vi.fn(), getHistory: vi.fn(),
  offer: vi.fn(), reassign: vi.fn(), sweepExpiredOffers: vi.fn(),
  AssignmentNotFound: class AssignmentNotFound extends Error {},
  InvalidTransition: class InvalidTransition extends Error {},
  NoBackupDesignated: class NoBackupDesignated extends Error {},
  ReasonRequired: class ReasonRequired extends Error {},
}));
vi.mock('../src/services/simulationService', () => ({
  readRotationState: vi.fn(), simulate: vi.fn(),
}));

/**
 * The response the engine returned BEFORE EP-379, frozen here as the baseline. If the
 * engine starts returning more, this test still pins what the ROUTE forwards.
 */
const LEGACY_RESULT = {
  assignment_id: 'asn-1',
  task_id: TASK,
  persona_id: PERSONA,
  status: 'proposed',
  assigned_at: '2026-01-01T00:00:00.000Z',
  strategy: 'default',
  distance_km: 4.2,
};

let app: FastifyInstance;

beforeAll(async () => {
  const { registerRoutes } = await import('../src/server/routes');
  app = Fastify({ logger: false });
  await app.register(registerRoutes);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

describe('POST /api/assignment/assign-by-task is unchanged', () => {
  it('accepts the original request body and answers 201 with { data: <result> }', async () => {
    assignByTask.mockResolvedValueOnce(LEGACY_RESULT);
    const res = await app.inject({
      method: 'POST',
      url: '/api/assignment/assign-by-task',
      payload: {
        task_id: TASK,
        tenant_id: TENANT,
        location: { lat: 37.7749, lng: -122.4194 },
        required_skills: ['roofing'],
        fallback_radius_km: 25,
        persona_locations: { [PERSONA]: { lat: 37.78, lng: -122.41 } },
        candidate_persona_ids: [PERSONA],
        strategy: 'round_robin',
        pool_key: 'west',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // The envelope: exactly one key, named data. A route that started returning
    // { data, meta } would break every caller destructuring the response.
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data).toEqual(LEGACY_RESULT);

    // And the engine still receives every field it used to, under the same names.
    expect(assignByTask).toHaveBeenCalledWith({
      task_id: TASK,
      tenant_id: TENANT,
      location: { lat: 37.7749, lng: -122.4194 },
      required_skills: ['roofing'],
      fallback_radius_km: 25,
      persona_locations: { [PERSONA]: { lat: 37.78, lng: -122.41 } },
      candidate_persona_ids: [PERSONA],
      strategy: 'round_robin',
      pool_key: 'west',
    });
  });

  it('still defaults required_skills to an empty array when omitted', async () => {
    assignByTask.mockResolvedValueOnce(LEGACY_RESULT);
    await app.inject({
      method: 'POST', url: '/api/assignment/assign-by-task',
      payload: { task_id: TASK, tenant_id: TENANT, location: { lat: 1, lng: 2 } },
    });
    expect(assignByTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ required_skills: [] }));
  });

  it('keeps the original 400 shape for a missing field', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/assignment/assign-by-task',
      payload: { tenant_id: TENANT, location: { lat: 1, lng: 2 } },
    });
    expect(res.statusCode).toBe(400);
    // { error, details } — NOT the { error, code, details } shape the new routes use.
    // Changing this would break a caller matching on the old body.
    expect(JSON.parse(res.body)).toEqual({
      error: 'ValidationError',
      details: ['task_id and tenant_id are required'],
    });
  });

  it('keeps the original 400 shape for a bad location and an invalid strategy', async () => {
    const noLocation = await app.inject({
      method: 'POST', url: '/api/assignment/assign-by-task',
      payload: { task_id: TASK, tenant_id: TENANT },
    });
    expect(JSON.parse(noLocation.body)).toEqual({
      error: 'ValidationError', details: ['location {lat,lng} is required'],
    });

    const badStrategy = await app.inject({
      method: 'POST', url: '/api/assignment/assign-by-task',
      payload: { task_id: TASK, tenant_id: TENANT, location: { lat: 1, lng: 2 }, strategy: 'vibes' },
    });
    expect(JSON.parse(badStrategy.body)).toEqual({
      error: 'ValidationError', details: ['invalid strategy'],
    });
  });

  it('keeps 409 NoEligiblePersona for an empty pool', async () => {
    assignByTask.mockRejectedValueOnce(new Error('no eligible persona within 25km'));
    const res = await app.inject({
      method: 'POST', url: '/api/assignment/assign-by-task',
      payload: { task_id: TASK, tenant_id: TENANT, location: { lat: 1, lng: 2 } },
    });
    expect(res.statusCode).toBe(409);
    // 409 rather than 4xx-generic on purpose: the task stays queued for a later
    // dispatcher pass, and a caller distinguishes that from bad input.
    expect(JSON.parse(res.body)).toEqual({
      error: 'NoEligiblePersona', message: 'no eligible persona within 25km',
    });
  });

  it('leaves the workload upsert contract alone too', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/assignment/workload/not-a-uuid', payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'ValidationError', details: ['persona_id must be a UUID'],
    });
  });

  it('the new routes exist alongside it, on paths that cannot collide', async () => {
    // The failure this guards: a new route registered at the same path silently
    // shadowing the old one. Fastify would throw at registration, but only if the
    // paths actually match — so the assertion is that BOTH resolve, each to itself.
    const legacy = app.hasRoute({ method: 'POST', url: '/api/assignment/assign-by-task' });
    expect(legacy).toBe(true);
    for (const url of [
      '/api/assignment/routes', '/api/assignment/route', '/api/assignment/simulate',
      '/api/assignments', '/api/assignments/sweep',
    ]) {
      expect(app.hasRoute({ method: 'POST', url }), `${url} is missing`).toBe(true);
    }
    expect(app.hasRoute({ method: 'GET', url: '/api/assignment/rotation' })).toBe(true);
  });
});
