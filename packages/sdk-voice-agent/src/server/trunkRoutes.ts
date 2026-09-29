import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { deleteTrunk, getTrunk, listTrunks, provisionTrunk, syncTrunkNumbers } from '../services/telephonyService';
import { resolveTenant } from './tenantScope';
import { sendError } from './sendError';

const actorOf = (req: { auth?: { primary_persona_id?: string | null; sub?: string } }): string =>
  req.auth?.primary_persona_id ?? req.auth?.sub ?? 'tenant-admin';

/** Tenant SIP trunk routes (VA·E6 · TK-4499/4501), tenant-scoped through resolveTenant. */
export function registerTrunkRoutes(app: FastifyInstance): void {
  app.post('/api/voice-agent/trunks', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { tenant_id?: string; carrier?: unknown; credential_binding_id?: unknown; carrier_trunk_ref?: unknown; trunk_sid?: unknown };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(201).send({ data: await provisionTrunk(tenantId, body, actorOf(req)) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string } }>('/api/voice-agent/trunks', { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = resolveTenant(req, reply, req.query.tenant_id);
    if (!tenantId) return reply;
    return reply.code(200).send({ data: { trunks: await listTrunks(tenantId) } });
  });

  app.get<{ Params: { trunk_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/trunks/:trunk_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: { trunk: await getTrunk(tenantId, req.params.trunk_id) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { trunk_id: string } }>(
    '/api/voice-agent/trunks/:trunk_id/sync-numbers', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: await syncTrunkNumbers(tenantId, req.params.trunk_id) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { trunk_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/trunks/:trunk_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: { trunk: await deleteTrunk(tenantId, req.params.trunk_id, actorOf(req)) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
