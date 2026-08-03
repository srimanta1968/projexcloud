/**
 * The sdk-crm route surface, pinned (P16 · EP-380 · TK-4072).
 *
 *   pnpm --filter @projexlight/sdk-crm test
 *
 * Adding the subject-generic routes must not move anything that was already there.
 * Every endpoint this SDK shipped before the enhancement is listed BELOW, literally,
 * and the test asserts each one is still registered with the same method and the same
 * path — including the trap cases: /api/crm/deals/:deal_id/next-action still exists
 * alongside the new /api/crm/subjects/:subject_ref/next-action, and the deal-scoped
 * save-gate did not quietly become the subject-generic one.
 *
 * Written as a literal list rather than a snapshot on purpose. A snapshot regenerates
 * when somebody runs the suite with -u, so it records what the code does rather than
 * what the SDK promised; a consumer whose integration breaks does not care which of
 * those two the file was.
 *
 * Behaviour of each endpoint is proven by its api_definition under
 * tests/api_definitions/crm/ (MUST-67) — this test proves the SURFACE, which is the
 * thing an additive change is most likely to break by accident.
 */
import fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/server/routes';

/** method + path exactly as Fastify registers it. */
const PRE_EXISTING: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/crm/contacts'],
  ['GET', '/api/crm/contacts/:contact_id'],
  ['PATCH', '/api/crm/contacts/:contact_id'],
  ['POST', '/api/crm/deals'],
  ['GET', '/api/crm/deals'],
  ['GET', '/api/crm/deals/:deal_id'],
  ['PATCH', '/api/crm/deals/:deal_id'],
  ['POST', '/api/crm/deals/:deal_id/transition'],
  ['GET', '/api/crm/deals/:deal_id/stage-guard'],
  ['POST', '/api/crm/deals/:deal_id/next-action'],
  ['GET', '/api/crm/deals/:deal_id/next-action'],
  ['POST', '/api/crm/deals/:deal_id/next-action/complete'],
  ['GET', '/api/crm/deals/:deal_id/save-gate'],
  ['GET', '/api/crm/pipeline/board'],
  ['GET', '/api/crm/pipeline/stale'],
  ['POST', '/api/crm/funnel-stages'],
  ['GET', '/api/crm/funnel-stages'],
  ['POST', '/api/crm/activities'],
  ['POST', '/api/crm/activities/call'],
  ['POST', '/api/crm/activities/voicemail'],
  ['GET', '/api/crm/activities/calls'],
];

const ADDED_BY_THIS_TASK: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/crm/subjects/:subject_ref/next-action'],
  ['GET', '/api/crm/subjects/:subject_ref/next-action'],
  ['GET', '/api/crm/subjects/:subject_ref/save-gate'],
  ['GET', '/api/crm/next-actions/overdue'],
  ['POST', '/api/crm/next-actions/:id/reschedule'],
  ['POST', '/api/crm/close-reasons'],
  ['GET', '/api/crm/pipeline/aging'],
];

const key = ([method, url]: readonly [string, string]) => `${method} ${url}`;

describe('sdk-crm route surface', () => {
  const registered = new Set<string>();

  beforeAll(async () => {
    const app = fastify();
    // onRoute fires as each route is added, so nothing has to be started and no
    // database, auth secret or environment is needed to read the surface.
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD') continue; // Fastify's automatic companion to every GET.
        registered.add(`${method} ${route.url}`);
      }
    });
    await registerRoutes(app);
    await app.ready();
  });

  it.each(PRE_EXISTING.map(key))('still serves %s', (endpoint) => {
    expect(registered.has(endpoint)).toBe(true);
  });

  it.each(ADDED_BY_THIS_TASK.map(key))('adds %s', (endpoint) => {
    expect(registered.has(endpoint)).toBe(true);
  });

  it('registers nothing beyond the documented surface', () => {
    // The other direction: an endpoint that exists but is written down nowhere has no
    // api_definition either, so QA never calls it and it drifts unobserved.
    const documented = new Set([...PRE_EXISTING, ...ADDED_BY_THIS_TASK].map(key));
    const undocumented = [...registered].filter((r) => !documented.has(r)).sort();
    expect(undocumented).toEqual([]);
  });

  it('keeps the deal-scoped next-action distinct from the subject-generic one', () => {
    // The enhancement generalises next-action; it does not replace the deal routes,
    // and a consumer still calling the deal path must not silently land elsewhere.
    expect(registered.has('POST /api/crm/deals/:deal_id/next-action')).toBe(true);
    expect(registered.has('POST /api/crm/subjects/:subject_ref/next-action')).toBe(true);
    expect(registered.has('GET /api/crm/deals/:deal_id/save-gate')).toBe(true);
    expect(registered.has('GET /api/crm/subjects/:subject_ref/save-gate')).toBe(true);
  });
});
