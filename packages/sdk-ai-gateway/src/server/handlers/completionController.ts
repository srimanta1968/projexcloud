import { FastifyReply, FastifyRequest } from 'fastify';
import type { AgentContext, CompletionRequest } from '@projexlight/contracts';
import { complete, stream } from '../../services/completionService';

/**
 * Pins the completion to the caller's tenant. context.tenant_id selects whose BYOK key the
 * provider call uses, so it must be the authenticated tenant: a different one is 403, an
 * absent one is filled from the token. Replies and returns false when refused.
 */
function pinTenant(req: FastifyRequest, reply: FastifyReply, context: AgentContext): boolean {
  const authTenant = (req as unknown as { auth?: { tenant_id?: string | null } }).auth?.tenant_id ?? null;
  if (!authTenant) return true;
  if (context.tenant_id && context.tenant_id !== authTenant) {
    reply.code(403).send({ success: false, error: 'context.tenant_id does not match the authenticated tenant' });
    return false;
  }
  context.tenant_id = authTenant;
  return true;
}

interface CompleteBody {
  request: CompletionRequest;
  context: AgentContext;
}

/**
 * POST /api/ai-gateway/complete — non-streaming completion. The agent
 * runtime (or any tool with a valid JWT) supplies (CompletionRequest,
 * AgentContext) and gets back a CompletionResponse with provider id,
 * tokens, cost, latency, and the trace_id propagated through the call.
 */
export async function completeHandler(
  req: FastifyRequest<{ Body: CompleteBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.request || !body?.context) {
    reply.code(400).send({ success: false, error: 'Missing required: request, context' });
    return;
  }
  if (!body.request.model || !body.request.prompt) {
    reply.code(400).send({ success: false, error: 'request.model and request.prompt are required' });
    return;
  }
  if (!body.context.agent_id || !body.context.run_id || !body.context.trace_id) {
    reply.code(400).send({
      success: false,
      error: 'context.agent_id, context.run_id, and context.trace_id are required',
    });
    return;
  }
  if (!pinTenant(req, reply, body.context)) return;
  try {
    const response = await complete(body.request, body.context);
    reply.code(200).send({ success: true, data: response });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not available') || msg.includes('no route matches')) {
      reply.code(503).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Completion failed' });
  }
}

/**
 * POST /api/ai-gateway/stream — server-sent events stream of chunks.
 * Each chunk is serialised as `data: <json>\n\n`. Stream closes on the
 * final chunk; client distinguishes the terminal frame via finish_reason.
 */
export async function streamHandler(
  req: FastifyRequest<{ Body: CompleteBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.request || !body?.context) {
    reply.code(400).send({ success: false, error: 'Missing required: request, context' });
    return;
  }
  if (!body.request.model || !body.request.prompt) {
    reply.code(400).send({ success: false, error: 'request.model and request.prompt are required' });
    return;
  }
  if (!body.context.agent_id || !body.context.run_id || !body.context.trace_id) {
    reply.code(400).send({
      success: false,
      error: 'context.agent_id, context.run_id, and context.trace_id are required',
    });
    return;
  }
  if (!pinTenant(req, reply, body.context)) return;
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();
  try {
    for await (const chunk of stream(body.request, body.context)) {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (err) {
    req.log.error(err);
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
  } finally {
    reply.raw.end();
  }
}
