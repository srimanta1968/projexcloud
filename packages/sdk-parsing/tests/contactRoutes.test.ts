import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Route-mounting smoke tests. The api_definitions are the real test artifact for these
 * endpoints; what they cannot catch before the gateway runs is a route that never mounts
 * or a validation branch whose shape drifts from what the definition documents.
 */

const lookupMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@projexlight/sdk-taxonomy', () => ({ lookupExtractionSchema: lookupMock }));
vi.mock('@projexlight/sdk-identity', () => ({ requireAuth: async () => undefined }));

let app: import('fastify').FastifyInstance;
const TENANT = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/server/routes');
  app = Fastify();
  await app.register(registerRoutes);
  await app.ready();
}, 30_000);

describe('routes mount', () => {
  it('registers extract, extract-batch and schemas', () => {
    const tree = app.printRoutes();
    expect(tree).toContain('extract');
    expect(tree).toContain('schemas');
  });
});

describe('POST /api/parsing/contact/extract', () => {
  it('extracts from a pasted signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/parsing/contact/extract',
      payload: {
        tenant_id: TENANT,
        source_kind: 'EMAIL_SIGNATURE',
        raw: 'Jane Okonkwo\nEngineer\njane@acme.com\n+44 20 7946 0958',
      },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.candidates[0].proposals.some((p: { field: string }) => p.field === 'email')).toBe(true);
    // Default must be off — no opt-in was sent.
    expect(d.llm_invoked).toBe(false);
  });

  it('refuses a missing raw, since evidence spans index into it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/parsing/contact/extract',
      payload: { tenant_id: TENANT, source_kind: 'SMART_PASTE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join(' ')).toMatch(/raw is required/);
  });

  it('refuses an unknown source_kind and lists the valid ones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/parsing/contact/extract',
      payload: { tenant_id: TENANT, source_kind: 'TELEPATHY', raw: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join(' ')).toMatch(/source_kind must be one of/);
  });

  it('treats a missing allow_llm as opt-OUT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/parsing/contact/extract',
      payload: { tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: 'nothing here', required_fields: ['email'] },
    });
    expect(res.json().data.llm_reason).toMatch(/did not opt in/);
  });
});

describe('POST /api/parsing/contact/extract-batch', () => {
  it('returns 200 with per-item outcomes even when one item fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/parsing/contact/extract-batch',
      payload: {
        tenant_id: TENANT,
        items: [
          { id: 'a', source_kind: 'SMART_PASTE', raw: 'jane@acme.com' },
          { id: 'b', source_kind: 'SMART_PASTE', raw: 'bob@acme.com' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok_count).toBe(2);
  });

  it('refuses an empty batch and an oversized one', async () => {
    const empty = await app.inject({
      method: 'POST', url: '/api/parsing/contact/extract-batch',
      payload: { tenant_id: TENANT, items: [] },
    });
    expect(empty.statusCode).toBe(400);

    const huge = await app.inject({
      method: 'POST', url: '/api/parsing/contact/extract-batch',
      payload: {
        tenant_id: TENANT,
        items: Array.from({ length: 101 }, () => ({ source_kind: 'SMART_PASTE', raw: 'x@y.com' })),
      },
    });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().details.join(' ')).toMatch(/may not exceed 100/);
  });

  it('names the offending index when an item is malformed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/parsing/contact/extract-batch',
      payload: { tenant_id: TENANT, items: [{ source_kind: 'SMART_PASTE', raw: 'ok@x.com' }, { source_kind: 'NOPE', raw: 'y' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.join(' ')).toMatch(/items\[1\]/);
  });
});

describe('GET /api/parsing/contact/schemas', () => {
  it('returns the resolved schema and the supported source kinds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/parsing/contact/schemas?tenant_id=${TENANT}`,
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.schema.source).toBe('builtin');
    expect(d.source_kinds).toContain('VCARD_MULTI');
  });

  it('refuses a missing tenant_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/parsing/contact/schemas' });
    expect(res.statusCode).toBe(400);
  });
});
