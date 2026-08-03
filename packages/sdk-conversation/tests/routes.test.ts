import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * Route-mounting smoke tests via Fastify inject.
 *
 * The api_definitions are the real test artifact for these endpoints (MUST-67); what they
 * cannot catch before the gateway is running is a route that never mounts, or a validation
 * branch that returns a different shape than the definition documents. Auth is stubbed
 * because the gateway's default-deny gate is exercised by the definitions' 401 errorCases,
 * not by this file.
 */

vi.mock('@projexlight/sdk-identity', () => ({
  requireAuth: async () => undefined,
}));

// Neither of these must be reached by the cases below — every one is a 400 that returns
// before any query. If a stub ever fires, the test has stopped testing what it claims.
vi.mock('../src/services/threadService', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    openThread: vi.fn(async () => { throw new Error('DB should not be reached'); }),
    recordMessage: vi.fn(async () => { throw new Error('DB should not be reached'); }),
    listInbox: vi.fn(async () => { throw new Error('DB should not be reached'); }),
    getThread: vi.fn(async () => { throw new Error('DB should not be reached'); }),
    listThreadMessages: vi.fn(async () => { throw new Error('DB should not be reached'); }),
    addInternalNote: vi.fn(async () => { throw new Error('DB should not be reached'); }),
  };
});

let app: import('fastify').FastifyInstance;

// 30s, not the config's 5s default: this hook cold-loads Fastify plus the whole service
// import chain, which is comfortably slower than a normal setup hook.
beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/server/routes');
  app = Fastify();
  await app.register(registerRoutes);
  await app.ready();
}, 30_000);

const TENANT = '22222222-2222-2222-2222-222222222222';

describe('routes mount at their declared paths', () => {
  it('registers all five endpoints', () => {
    const tree = app.printRoutes();
    for (const p of ['threads', 'messages', 'inbox', 'compose-guardrail']) {
      expect(tree).toContain(p);
    }
  });
});

describe('compose-guardrail returns ordered reasons over HTTP (AC1/AC2/AC3)', () => {
  it('ranks the permanent reason above the temporary one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/compose-guardrail',
      payload: {
        tenant_id: TENANT,
        channels: ['SMS'],
        channel_facts: { SMS: { quiet_hours: true, opted_out: true } },
      },
    });
    expect(res.statusCode).toBe(200);
    const sms = res.json().data.decision.channels[0];
    expect(sms.verdict).toBe('deny');
    expect(sms.reasons.map((r: { code: string }) => r.code)).toEqual(['OPTED_OUT', 'QUIET_HOURS']);
  });

  it('recommends the first allowed channel in the caller\'s order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/compose-guardrail',
      payload: {
        tenant_id: TENANT,
        channels: ['SMS', 'EMAIL'],
        channel_facts: { SMS: { suppressed: true }, EMAIL: {} },
      },
    });
    expect(res.json().data.decision.recommended_channel).toBe('EMAIL');
  });

  it('refuses to decide without resolver output', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/compose-guardrail',
      payload: { tenant_id: TENANT, channels: ['EMAIL'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('refuses an empty channel list and an unknown channel', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/conversations/compose-guardrail',
      payload: { tenant_id: TENANT, channels: [], channel_facts: {} },
    });
    expect(empty.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/conversations/compose-guardrail',
      payload: { tenant_id: TENANT, channels: ['TELEPATHY'], channel_facts: {} },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().details.join(' ')).toMatch(/unknown channel/i);
  });
});

describe('validation shapes match what the api_definitions document', () => {
  it('POST /threads refuses a missing purpose with VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/threads',
      payload: { tenant_id: TENANT, subject_ref: 'lead:1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.json().details.join(' ')).toMatch(/purpose is required/);
  });

  it('POST /messages refuses an unknown channel and a missing body_ref', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations/messages',
      payload: { tenant_id: TENANT, thread_id: 't', channel: 'CARRIER_PIGEON', actor: 'a' },
    });
    expect(res.statusCode).toBe(400);
    const details = res.json().details.join(' ');
    expect(details).toMatch(/body_ref is required/);
    expect(details).toMatch(/channel must be one of/);
  });

  it('GET /inbox refuses a missing tenant_id and an unknown channel', async () => {
    const noTenant = await app.inject({ method: 'GET', url: '/api/conversations/inbox' });
    expect(noTenant.statusCode).toBe(400);

    const badChannel = await app.inject({
      method: 'GET',
      url: `/api/conversations/inbox?tenant_id=${TENANT}&channel=TELEPATHY`,
    });
    expect(badChannel.statusCode).toBe(400);
  });

  it('GET /threads/:id refuses a missing tenant_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversations/threads/abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});
