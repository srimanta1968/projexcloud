import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { effectiveTools, getTool, listTools, registerTool, updateTool, type RegisterToolInput, type UpdateToolInput } from '../services/toolService';
import { getVersion } from '../services/agentService';
import { resolveTenant } from './tenantScope';
import { sendError } from './sendError';

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

/** App-registered tool routes (VA·E2 · TK-4473), tenant-scoped through resolveTenant. */
export function registerToolRoutes(app: FastifyInstance): void {
  app.post('/api/voice-agent/tools', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<RegisterToolInput> & { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(201).send({ data: { tool: await registerTool(tenantId, body as RegisterToolInput) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { tenant_id?: string; app_id?: string; enabled?: string; limit?: string; offset?: string } }>(
    '/api/voice-agent/tools', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const page = await listTools(tenantId, {
          app_id: req.query.app_id, enabled: req.query.enabled, limit: num(req.query.limit), offset: num(req.query.offset),
        });
        return reply.code(200).send({ data: page });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { tool_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/tools/:tool_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const tool = await getTool(tenantId, req.params.tool_id);
      if (!tool) return reply.code(404).send({ error: 'NotFound', details: ['tool not found'] });
      return reply.code(200).send({ data: { tool } });
    },
  );

  app.patch<{ Params: { tool_id: string } }>(
    '/api/voice-agent/tools/:tool_id', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as UpdateToolInput & { tenant_id?: string; name?: unknown; app_id?: unknown };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: { tool: await updateTool(tenantId, req.params.tool_id, body) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // What a NEW call on this version is offered — enabled tools only.
  app.get<{ Params: { agent_id: string; version_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/tools', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const version = await getVersion(tenantId, req.params.agent_id, req.params.version_id);
      if (!version) return reply.code(404).send({ error: 'NotFound', details: ['agent version not found'] });
      return reply.code(200).send({ data: { tools: await effectiveTools(tenantId, version.version_id) } });
    },
  );
}
