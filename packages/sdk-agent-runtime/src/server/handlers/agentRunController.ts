import { FastifyReply, FastifyRequest } from 'fastify';
import {
  startAgentRun,
  getAgentRun,
  listAgentRuns,
  type StartRunInput,
  type AgentRunStatus,
} from '../../services/agentRunLifecycle';
import {
  createAgentDefinition,
  getAgentDefinition,
  listAgentDefinitions,
  type CreateAgentDefinitionInput,
  type AgentTier,
} from '../../services/agentDefinitionService';

interface IdParams { id: string; }

/* ---------------- agent_definition ---------------- */

export async function createAgentDefinitionHandler(
  req: FastifyRequest<{ Body: CreateAgentDefinitionInput }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.name || !body?.acting_persona_id || !body?.tier || !body?.vector_namespace || !body?.created_by) {
    reply.code(400).send({
      success: false,
      error: 'Required: name, acting_persona_id, tier, vector_namespace, created_by',
    });
    return;
  }
  try {
    const def = await createAgentDefinition(body);
    reply.code(201).send({ success: true, data: def });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Create failed' });
  }
}

export async function getAgentDefinitionHandler(
  req: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  if (!req.params.id) {
    reply.code(400).send({ success: false, error: 'Missing path param: id' });
    return;
  }
  try {
    const def = await getAgentDefinition(req.params.id);
    if (!def) {
      reply.code(404).send({ success: false, error: 'agent_definition not found' });
      return;
    }
    reply.code(200).send({ success: true, data: def });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Lookup failed' });
  }
}

interface ListDefQuery {
  tenant_id?: string;
  tier?: AgentTier;
  limit?: string;
  offset?: string;
}

export async function listAgentDefinitionsHandler(
  req: FastifyRequest<{ Querystring: ListDefQuery }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const list = await listAgentDefinitions({
      tenant_id: req.query?.tenant_id ?? null,
      tier: req.query?.tier,
      limit: req.query?.limit ? parseInt(req.query.limit, 10) : undefined,
      offset: req.query?.offset ? parseInt(req.query.offset, 10) : undefined,
    });
    reply.code(200).send({ success: true, data: list });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'List failed' });
  }
}

/* ---------------- agent_run lifecycle ---------------- */

export async function startAgentRunHandler(
  req: FastifyRequest<{ Body: StartRunInput }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.agent_id || !body?.persona_id || !body?.trace_id || !body?.actor_id || !body?.actor_kind) {
    reply.code(400).send({
      success: false,
      error: 'Required: agent_id, persona_id, trace_id, actor_id, actor_kind',
    });
    return;
  }
  try {
    const run = await startAgentRun(body);
    reply.code(201).send({ success: true, data: run });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Start run failed' });
  }
}

export async function getAgentRunHandler(
  req: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  if (!req.params.id) {
    reply.code(400).send({ success: false, error: 'Missing path param: id' });
    return;
  }
  try {
    const run = await getAgentRun(req.params.id);
    if (!run) {
      reply.code(404).send({ success: false, error: 'agent_run not found' });
      return;
    }
    reply.code(200).send({ success: true, data: run });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Lookup failed' });
  }
}

interface ListRunQuery {
  tenant_id?: string;
  agent_id?: string;
  status?: AgentRunStatus;
  limit?: string;
  offset?: string;
}

export async function listAgentRunsHandler(
  req: FastifyRequest<{ Querystring: ListRunQuery }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const list = await listAgentRuns({
      tenant_id: req.query?.tenant_id ?? null,
      agent_id: req.query?.agent_id,
      status: req.query?.status,
      limit: req.query?.limit ? parseInt(req.query.limit, 10) : undefined,
      offset: req.query?.offset ? parseInt(req.query.offset, 10) : undefined,
    });
    reply.code(200).send({ success: true, data: list });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'List failed' });
  }
}
