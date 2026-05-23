import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createSandboxTenant,
  getState,
  offboardTenant,
  reinstateTenant,
  suspendTenant,
} from '../services/tenantLifecycleService';

/**
 * Ownership check for tenant-targeted routes: the JWT's tenant_id must match
 * the path tenant_id, OR the JWT's parent_tenant_id must equal the path
 * tenant_id (the reseller-attached path per FR-TLC-7). Both cases also
 * cover the admin-pool operator who carries an admin tenant_id matching the
 * platform admin tenant via separate IAM rather than via this check.
 */
function ownsTenant(req: FastifyRequest, tenant_id: string): boolean {
  const auth = req.auth;
  if (!auth) return false;
  if (auth.tenant_id === tenant_id) return true;
  if (auth.parent_tenant_id === tenant_id) return true;
  return false;
}

function forbid(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: 'Forbidden', details: ['Tenant ownership check failed'] });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenant-lifecycle/:tenant_id/suspend',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenant_id } = req.params;
      if (!ownsTenant(req, tenant_id)) return forbid(reply);
      const body = (req.body as Partial<{ reason: string }>) ?? {};
      if (!body.reason) {
        return reply.code(400).send({ error: 'ValidationError', details: ['reason is required'] });
      }
      try {
        const state = await suspendTenant(tenant_id, body.reason, req.auth?.sub ?? 'api-gateway');
        return reply.code(200).send({ data: { state } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenant-lifecycle/:tenant_id/reinstate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenant_id } = req.params;
      if (!ownsTenant(req, tenant_id)) return forbid(reply);
      try {
        const state = await reinstateTenant(tenant_id, req.auth?.sub ?? 'api-gateway');
        return reply.code(200).send({ data: { state } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  app.post<{ Params: { tenant_id: string } }>(
    '/api/tenant-lifecycle/:tenant_id/offboard',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenant_id } = req.params;
      if (!ownsTenant(req, tenant_id)) return forbid(reply);
      const body = (req.body as Partial<{ deadline_at: string }>) ?? {};
      // Default grace period: 30 days per FR-TLC-6.
      const deadline = body.deadline_at
        ? new Date(body.deadline_at)
        : new Date(Date.now() + 30 * 86_400_000);
      if (isNaN(deadline.getTime())) {
        return reply.code(400).send({ error: 'ValidationError', details: ['deadline_at must be ISO-8601'] });
      }
      try {
        const state = await offboardTenant(tenant_id, req.auth?.sub ?? 'api-gateway', deadline);
        return reply.code(200).send({ data: { state } });
      } catch (err) {
        return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
      }
    },
  );

  app.post(
    '/api/tenant-lifecycle/sandbox',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parent_tenant_id = req.auth?.tenant_id;
      if (!parent_tenant_id) {
        return reply.code(403).send({ error: 'Forbidden', details: ['Caller must have tenant_id'] });
      }
      const body = (req.body as Partial<{ expires_at: string; sanitization_policy: string }>) ?? {};
      const expires = body.expires_at ? new Date(body.expires_at) : undefined;
      if (expires && isNaN(expires.getTime())) {
        return reply.code(400).send({ error: 'ValidationError', details: ['expires_at must be ISO-8601'] });
      }
      const sandbox = await createSandboxTenant({
        parent_tenant_id,
        expires_at: expires,
        sanitization_policy: body.sanitization_policy,
        actor_id: req.auth?.sub ?? 'api-gateway',
      });
      return reply.code(201).send({ data: { sandbox } });
    },
  );

  app.get<{ Params: { tenant_id: string } }>(
    '/api/tenant-lifecycle/:tenant_id/state',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenant_id } = req.params;
      if (!ownsTenant(req, tenant_id)) return forbid(reply);
      const state = await getState(tenant_id);
      if (!state) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { state } });
    },
  );
}

export const registerTenantLifecycleRoutes = registerRoutes;
