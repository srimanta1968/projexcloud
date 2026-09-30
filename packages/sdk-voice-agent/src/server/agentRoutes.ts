import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createAgent,
  createVersion,
  getAgent,
  listAgents,
  listVersions,
  publishVersion,
  recordEvalRun,
  requestPublishApproval,
  rollbackAgent,
  type CreateAgentInput,
  type CreateVersionInput,
  type RecordEvalRunInput,
} from '../services/agentService';
import { bindNumber, listNumbers, setKillSwitch, unbindNumber, type BindNumberInput } from '../services/numberService';
import { getEvalRun, listEvalRuns, startEvalRun } from '../services/evalRunService';
import { resolveTenant } from './tenantScope';
import { sendError } from './sendError';

type AgentParams = { agent_id: string };
type VersionParams = { agent_id: string; version_id: string };
type PageQuery = { tenant_id?: string; limit?: string; offset?: string };

const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

/**
 * Agent, version, evaluation-run, publish and rollback routes (VA·E2 · TK-4470/4471).
 * Every route is tenant-scoped through resolveTenant.
 */
export function registerAgentRoutes(app: FastifyInstance): void {
  app.post('/api/voice-agent/agents', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateAgentInput> & { tenant_id?: string };
    const tenantId = resolveTenant(req, reply, body.tenant_id);
    if (!tenantId) return reply;
    try {
      return reply.code(201).send({ data: { agent: await createAgent(tenantId, body as CreateAgentInput) } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: PageQuery & { status?: string; direction?: string } }>(
    '/api/voice-agent/agents', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const page = await listAgents(tenantId, {
          status: req.query.status, direction: req.query.direction,
          limit: num(req.query.limit), offset: num(req.query.offset),
        });
        return reply.code(200).send({ data: page });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: AgentParams; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/agents/:agent_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const agent = await getAgent(tenantId, req.params.agent_id);
      if (!agent) return reply.code(404).send({ error: 'NotFound', details: ['agent not found'] });
      return reply.code(200).send({ data: { agent } });
    },
  );

  app.post<{ Params: AgentParams }>(
    '/api/voice-agent/agents/:agent_id/versions', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as Partial<CreateVersionInput> & { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const version = await createVersion(tenantId, req.params.agent_id, body as CreateVersionInput);
        return reply.code(201).send({ data: { version } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: AgentParams; Querystring: PageQuery }>(
    '/api/voice-agent/agents/:agent_id/versions', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const page = await listVersions(tenantId, req.params.agent_id, { limit: num(req.query.limit), offset: num(req.query.offset) });
        return reply.code(200).send({ data: page });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: VersionParams }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as Partial<RecordEvalRunInput> & { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const evalRun = await recordEvalRun(tenantId, req.params.agent_id, req.params.version_id, body as RecordEvalRunInput);
        return reply.code(201).send({ data: { eval_run: evalRun } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // TK-4517/4518 — start a simulated-caller run (sandbox: fake providers + scripted agent,
  // never unlocks publish; evaluation: the tenant's real LLM + tools, gates publish). Queued;
  // a voice-runtime worker runs it. 202 Accepted: the result comes later (GET the run).
  app.post<{ Params: VersionParams }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs/start', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; mode?: unknown; scenarios?: unknown; suite?: unknown };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const actor = req.auth?.primary_persona_id ?? req.auth?.sub ?? 'unknown';
        const evalRun = await startEvalRun(tenantId, req.params.agent_id, req.params.version_id, body, actor);
        return reply.code(202).send({ data: { eval_run: evalRun } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: VersionParams; Querystring: { tenant_id?: string; limit?: string; offset?: string } }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const page = await listEvalRuns(tenantId, req.params.agent_id, req.params.version_id, { limit: num(req.query.limit), offset: num(req.query.offset) });
        return reply.code(200).send({ data: page });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { eval_run_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/eval-runs/:eval_run_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: { eval_run: await getEvalRun(tenantId, req.params.eval_run_id) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Action endpoint: opens (or returns the open) approval request — 200, not 201.
  app.post<{ Params: VersionParams }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/publish-request', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; route_id?: string; initiator_persona_id?: string; reason?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const result = await requestPublishApproval(tenantId, req.params.agent_id, req.params.version_id, {
          route_id: body.route_id,
          initiator_persona_id: body.initiator_persona_id ?? req.auth?.primary_persona_id ?? req.auth?.sub,
          reason: body.reason,
        });
        return reply.code(200).send({ data: result });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: VersionParams }>(
    '/api/voice-agent/agents/:agent_id/versions/:version_id/publish', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: await publishVersion(tenantId, req.params.agent_id, req.params.version_id) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // TK-4472 — inbound number bindings.
  app.post<{ Params: AgentParams }>(
    '/api/voice-agent/agents/:agent_id/numbers', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as Partial<BindNumberInput> & { tenant_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(201).send({ data: { binding: await bindNumber(tenantId, req.params.agent_id, body as BindNumberInput) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: AgentParams; Querystring: { tenant_id?: string; include_inactive?: string } }>(
    '/api/voice-agent/agents/:agent_id/numbers', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      try {
        const bindings = await listNumbers(tenantId, req.params.agent_id, req.query.include_inactive === 'true');
        return reply.code(200).send({ data: { bindings } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: AgentParams & { binding_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/voice-agent/agents/:agent_id/numbers/:binding_id', { preHandler: requireAuth }, async (req, reply) => {
      const tenantId = resolveTenant(req, reply, req.query.tenant_id);
      if (!tenantId) return reply;
      const found = await unbindNumber(tenantId, req.params.agent_id, req.params.binding_id);
      if (!found) return reply.code(404).send({ error: 'NotFound', details: ['number binding not found'] });
      return reply.code(204).send();
    },
  );

  // TK-4472 — kill switch (action endpoint, 200).
  app.post<{ Params: AgentParams }>(
    '/api/voice-agent/agents/:agent_id/kill-switch', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; engaged?: unknown; message?: unknown };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        const actor = req.auth?.primary_persona_id ?? req.auth?.sub ?? 'unknown';
        const state = await setKillSwitch(tenantId, req.params.agent_id, body, actor);
        return reply.code(200).send({ data: { kill_switch: state } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: AgentParams }>(
    '/api/voice-agent/agents/:agent_id/rollback', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; version_id?: string };
      const tenantId = resolveTenant(req, reply, body.tenant_id);
      if (!tenantId) return reply;
      try {
        return reply.code(200).send({ data: await rollbackAgent(tenantId, req.params.agent_id, body.version_id) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
