import { FastifyReply, FastifyRequest } from 'fastify';
import {
  registerMcpServer,
  getMcpServer,
  listMcpServers,
  disableMcpServer,
  type RegisterMcpServerInput,
} from '../../services/mcpRegistration';
import {
  invokeMcpTool,
  type InvokeMcpToolInput,
} from '../../services/mcpInvocation';

interface IdParams { id: string; }

/* -------------------- registration -------------------- */

interface RegisterBody {
  tenant_id: string;
  display_name: string;
  transport: 'http' | 'sse' | 'stdio';
  endpoint_url: string;
  /** Base64-encoded credential envelope (vault-wrapped or raw bearer for dev). */
  credential_envelope_b64: string;
  allowed_agent_ids?: string[];
}

export async function registerServerHandler(
  req: FastifyRequest<{ Body: RegisterBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.tenant_id || !body?.display_name || !body?.transport || !body?.endpoint_url || !body?.credential_envelope_b64) {
    reply.code(400).send({
      success: false,
      error: 'Required: tenant_id, display_name, transport, endpoint_url, credential_envelope_b64',
    });
    return;
  }
  const actor = req.auth?.sub ?? 'system';
  try {
    const result = await registerMcpServer({
      tenant_id: body.tenant_id,
      display_name: body.display_name,
      transport: body.transport,
      endpoint_url: body.endpoint_url,
      credential_envelope: Buffer.from(body.credential_envelope_b64, 'base64'),
      allowed_agent_ids: body.allowed_agent_ids,
      actor_id: actor,
    } as RegisterMcpServerInput);
    reply.code(201).send({ success: true, data: result });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('probe failed')) {
      reply.code(502).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Register failed' });
  }
}

export async function getServerHandler(
  req: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const row = await getMcpServer(req.params.id);
    if (!row) {
      reply.code(404).send({ success: false, error: 'server_registration not found' });
      return;
    }
    reply.code(200).send({ success: true, data: row });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Lookup failed' });
  }
}

interface ListQuery { tenant_id?: string; }

export async function listServersHandler(
  req: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply,
): Promise<void> {
  if (!req.query?.tenant_id) {
    reply.code(400).send({ success: false, error: 'Missing query param: tenant_id' });
    return;
  }
  try {
    const list = await listMcpServers(req.query.tenant_id);
    reply.code(200).send({ success: true, data: list });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'List failed' });
  }
}

export async function disableServerHandler(
  req: FastifyRequest<{ Params: IdParams; Body: { reason: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const reason = req.body?.reason;
  if (!reason) {
    reply.code(400).send({ success: false, error: 'reason is required' });
    return;
  }
  const actor = req.auth?.sub ?? 'system';
  try {
    await disableMcpServer({ registration_id: req.params.id, actor_id: actor, reason });
    reply.code(200).send({ success: true, data: { registration_id: req.params.id, disabled: true } });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Disable failed' });
  }
}

/* -------------------- invocation -------------------- */

interface InvokeBody {
  agent_run_id: string;
  capability_token_id: string;
  args: unknown;
  trace_id: string;
}

interface ToolIdParams { tool_id: string; }

export async function invokeToolHandler(
  req: FastifyRequest<{ Params: ToolIdParams; Body: InvokeBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.agent_run_id || !body?.capability_token_id || body?.args === undefined || !body?.trace_id) {
    reply.code(400).send({
      success: false,
      error: 'Required: agent_run_id, capability_token_id, args, trace_id',
    });
    return;
  }
  try {
    const result = await invokeMcpTool({
      tool_id: req.params.tool_id,
      agent_run_id: body.agent_run_id,
      capability_token_id: body.capability_token_id,
      args: body.args,
      trace_id: body.trace_id,
    } as InvokeMcpToolInput);
    const statusCode = result.outcome === 'succeeded' ? 200 : 403;
    reply.code(statusCode).send({ success: result.outcome === 'succeeded', data: result });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    if (msg.includes('opted out') || msg.includes('status=')) {
      reply.code(403).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Invoke failed' });
  }
}
