import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import type { ConfigScope, ConfigContext } from '../index';
import { resolveConfig } from '../services/resolveConfig';
import {
  setConfig,
  getConfig,
  listConfig,
  revokeConfig,
  rotateConfigSecret,
} from '../services/configStore';

const SCOPES: ConfigScope[] = ['platform', 'tenant', 'app', 'app_user'];

interface AuthClaims {
  sub?: string;
  tenant_id?: string | null;
  app_id?: string | null;
  roles?: string[];
}

/** Tenant-admin-ish roles that may manage tenant/app config for their tenant. */
function isTenantAdmin(a: AuthClaims): boolean {
  const r = a.roles ?? [];
  return r.includes('tenant_admin') || r.includes('tenant-admin') || r.includes('admin') || r.includes('platform_operator');
}

function claims(req: FastifyRequest): AuthClaims {
  return ((req as unknown as { auth?: AuthClaims }).auth) ?? {};
}

/** Build the resolution context from the caller's JWT, allowing explicit
 *  app_id / app_user_id query overrides (tenant is always the caller's). */
function ctxFrom(req: FastifyRequest, q: { app_id?: string; app_user_id?: string }): ConfigContext {
  const a = claims(req);
  return {
    tenant_id: a.tenant_id ?? null,
    app_id: q.app_id ?? a.app_id ?? null,
    app_user_id: q.app_user_id ?? a.sub ?? null,
  };
}

/** Scope-ownership guard (EP-341 app-scope authorization). Returns an error
 *  string when the caller may not write the given (scope, scope_id), else null.
 *   - platform : platform operators only.
 *   - tenant   : the caller's own tenant only.
 *   - app      : OWNING-TENANT ADMINS ONLY — a tenant-admin of the tenant that
 *                the app belongs to (proxied by the caller being authenticated
 *                into that app: scope_id === the JWT app_id) or an explicit
 *                tenant-admin role acting within their tenant.
 *   - app_user : the end-user themselves (scope_id === their own sub), or a
 *                tenant admin managing a user in their tenant. */
function assertWritable(req: FastifyRequest, scope: ConfigScope, scope_id: string): string | null {
  const a = claims(req);
  if (scope === 'platform') {
    return a.roles?.includes('platform_operator') ? null : 'platform config requires a platform operator';
  }
  if (!a.tenant_id) return 'a tenant context is required';
  if (scope === 'tenant') {
    return scope_id === a.tenant_id ? null : "cannot write another tenant's config";
  }
  if (scope === 'app') {
    // Owning-tenant admins only: either the caller is authenticated into this
    // very app (member of the owning tenant) or holds a tenant-admin role.
    if (scope_id === a.app_id || isTenantAdmin(a)) return null;
    return 'app config requires an owning-tenant admin';
  }
  if (scope === 'app_user') {
    // The user themselves, or a tenant admin managing their tenant's users.
    if (scope_id === a.sub || isTenantAdmin(a)) return null;
    return 'app_user config requires the user themselves or a tenant admin';
  }
  return null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Resolve the most-specific active value for a key in the caller's context.
  app.get<{ Querystring: { key?: string; app_id?: string; app_user_id?: string } }>(
    '/api/config/resolve',
    { preHandler: requireAuth },
    async (req, reply) => {
      const key = req.query.key;
      if (!key) return reply.code(400).send({ error: 'ValidationError', details: ['key is required'] });
      const row = await resolveConfig(key, ctxFrom(req, req.query));
      return {
        data: {
          key,
          resolved: row
            ? { scope: row.scope, scope_id: row.scope_id, value: row.value, secret_ref: row.secret_ref }
            : null,
        },
      };
    },
  );

  // List active config rows for a scope.
  app.get<{ Querystring: { scope?: string; scope_id?: string } }>(
    '/api/config',
    { preHandler: requireAuth },
    async (req, reply) => {
      const scope = req.query.scope as ConfigScope | undefined;
      if (!scope || !SCOPES.includes(scope)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['scope must be platform|tenant|app|app_user'] });
      }
      const scope_id = req.query.scope_id ?? (scope === 'tenant' ? claims(req).tenant_id ?? '' : '');
      return { data: await listConfig(scope, scope_id) };
    },
  );

  // Get one config row (exact scope/scope_id/key).
  app.get<{ Querystring: { scope?: string; scope_id?: string; key?: string } }>(
    '/api/config/value',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { scope, scope_id, key } = req.query;
      if (!scope || !SCOPES.includes(scope as ConfigScope) || !key) {
        return reply.code(400).send({ error: 'ValidationError', details: ['scope and key are required'] });
      }
      const row = await getConfig(scope as ConfigScope, scope_id ?? '', key);
      if (!row) return reply.code(404).send({ error: 'NotFound', details: ['config value not found'] });
      return { data: row };
    },
  );

  // Upsert a config value (non-secret `value` or secret `secret_ref`).
  app.post<{
    Body: { scope?: string; scope_id?: string; key?: string; value?: Record<string, unknown>; secret_ref?: string };
  }>('/api/config', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.scope || !SCOPES.includes(b.scope as ConfigScope) || !b.key) {
      return reply.code(400).send({ error: 'ValidationError', details: ['scope (platform|tenant|app|app_user) and key are required'] });
    }
    if (b.value != null && b.secret_ref != null) {
      return reply.code(400).send({ error: 'ValidationError', details: ['provide value OR secret_ref, not both'] });
    }
    const scope = b.scope as ConfigScope;
    const scope_id = b.scope_id ?? (scope === 'platform' ? '' : claims(req).tenant_id ?? '');
    const authErr = assertWritable(req, scope, scope_id);
    if (authErr) return reply.code(403).send({ error: 'Forbidden', details: [authErr] });
    const data = await setConfig({
      scope,
      scope_id,
      key: b.key,
      value: b.value ?? null,
      secret_ref: b.secret_ref ?? null,
      set_by: claims(req).sub ?? null,
    });
    return reply.code(201).send({ data });
  });

  // Revoke (soft-delete) a config value.
  app.post<{ Body: { scope?: string; scope_id?: string; key?: string } }>(
    '/api/config/revoke',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.scope || !SCOPES.includes(b.scope as ConfigScope) || !b.key) {
        return reply.code(400).send({ error: 'ValidationError', details: ['scope and key are required'] });
      }
      const scope = b.scope as ConfigScope;
      const scope_id = b.scope_id ?? (scope === 'platform' ? '' : claims(req).tenant_id ?? '');
      const authErr = assertWritable(req, scope, scope_id);
      if (authErr) return reply.code(403).send({ error: 'Forbidden', details: [authErr] });
      const data = await revokeConfig(scope, scope_id, b.key, claims(req).sub ?? null);
      if (!data) return reply.code(404).send({ error: 'NotFound', details: ['config value not found'] });
      return { data };
    },
  );

  // Rotate a secret value's envelope pointer in place.
  app.post<{ Body: { scope?: string; scope_id?: string; key?: string; secret_ref?: string } }>(
    '/api/config/rotate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.scope || !SCOPES.includes(b.scope as ConfigScope) || !b.key || !b.secret_ref) {
        return reply.code(400).send({ error: 'ValidationError', details: ['scope, key and secret_ref are required'] });
      }
      const scope = b.scope as ConfigScope;
      const scope_id = b.scope_id ?? (scope === 'platform' ? '' : claims(req).tenant_id ?? '');
      const authErr = assertWritable(req, scope, scope_id);
      if (authErr) return reply.code(403).send({ error: 'Forbidden', details: [authErr] });
      const data = await rotateConfigSecret(scope, scope_id, b.key, b.secret_ref, claims(req).sub ?? null);
      if (!data) return reply.code(404).send({ error: 'NotFound', details: ['config value not found'] });
      return { data };
    },
  );
}
