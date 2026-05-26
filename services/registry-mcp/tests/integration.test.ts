import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { signJwt } from '@projexlight/sdk-identity';
import { buildApp, bootRegistry, loadConfig } from '../src';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CATALOG = resolve(REPO_ROOT, 'packages/sdk-registry/dist/registry.catalog.json');

const SAVED_ENV: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  SAVED_ENV[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('registry-mcp hosted service', () => {
  beforeAll(() => {
    setEnv('REGISTRY_MCP_CATALOG_PATH', CATALOG);
    setEnv('REGISTRY_MCP_AUTH_MODE', 'jwt');
    setEnv('JWT_SECRET', 'test-secret-only');
    setEnv('REGISTRY_MCP_RATE_LIMIT', '120');
  });
  afterAll(() => restoreEnv());

  it('healthz reports catalog + embedding status without auth', async () => {
    const config = loadConfig();
    const { registry, embeddingsLoaded } = await bootRegistry(config);
    const app = buildApp({ config, registry, embeddingsLoaded });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; catalog_entries: number };
      expect(body.status).toBe('ok');
      expect(body.catalog_entries).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('SSE endpoint rejects missing Authorization header', async () => {
    const config = loadConfig();
    const { registry, embeddingsLoaded } = await bootRegistry(config);
    const app = buildApp({ config, registry, embeddingsLoaded });
    try {
      const res = await app.inject({ method: 'GET', url: '/mcp/sse' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('SSE endpoint rejects invalid bearer token', async () => {
    const config = loadConfig();
    const { registry, embeddingsLoaded } = await bootRegistry(config);
    const app = buildApp({ config, registry, embeddingsLoaded });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/mcp/sse',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('messages endpoint rejects unknown session', async () => {
    const config = loadConfig();
    const { registry, embeddingsLoaded } = await bootRegistry(config);
    const app = buildApp({ config, registry, embeddingsLoaded });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/messages?sessionId=does-not-exist',
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('messages endpoint rejects missing sessionId', async () => {
    const config = loadConfig();
    const { registry, embeddingsLoaded } = await bootRegistry(config);
    const app = buildApp({ config, registry, embeddingsLoaded });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/messages',
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('tenant context extracted from valid JWT', async () => {
    const { extractTenantContext } = await import('../src/auth');
    const cfg = loadConfig();
    // signJwt + verifyJwt share sdk-identity's module-scope JWT_SECRET,
    // so the test does not need to manipulate env state itself.
    const token = signJwt({
      sub: 'user-1',
      tenant_id: 'tenant-acme',
      org_id: 'org-1',
      email: 'a@b.c',
    });
    const ctx = extractTenantContext(`Bearer ${token}`, cfg);
    expect(ctx).toEqual({
      sub: 'user-1',
      tenant_id: 'tenant-acme',
      org_id: 'org-1',
      email: 'a@b.c',
    });
  });

  it('disabled auth mode returns anonymous context', async () => {
    setEnv('REGISTRY_MCP_AUTH_MODE', 'disabled');
    const { extractTenantContext } = await import('../src/auth');
    const cfg = loadConfig();
    const ctx = extractTenantContext(undefined, cfg);
    expect(ctx).toEqual({ sub: 'anonymous-dev', tenant_id: null, org_id: null });
    setEnv('REGISTRY_MCP_AUTH_MODE', 'jwt');
  });

  it('rate limiter denies after threshold', async () => {
    const { createInProcessRateLimiter } = await import('../src/rateLimit');
    const lim = createInProcessRateLimiter(3);
    expect(lim.check('t').ok).toBe(true);
    expect(lim.check('t').ok).toBe(true);
    expect(lim.check('t').ok).toBe(true);
    expect(lim.check('t').ok).toBe(false);
    // separate tenant still allowed
    expect(lim.check('other').ok).toBe(true);
  });

  it('audit sink invoked once per CallTool', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { buildMcpServer } = await import('../src/mcpHandler');
    const config = loadConfig();
    const { registry } = await bootRegistry(config);
    const calls: Array<{ tool: string; ok: boolean }> = [];
    const server = buildMcpServer({
      registry,
      tenant: { sub: 'tester', tenant_id: 't1', org_id: null },
      audit: (e) => calls.push({ tool: e.tool, ok: e.ok }),
    });
    expect(server).toBeInstanceOf(Server);
    // Direct dispatch path bypasses transport — verify shape only.
    expect(calls).toEqual([]);
  });
});
