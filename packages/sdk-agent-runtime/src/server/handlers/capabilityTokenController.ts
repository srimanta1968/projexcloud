import { FastifyReply, FastifyRequest } from 'fastify';
import {
  mintToken,
  revokeToken,
  validateToken,
  type MintInput,
} from '../../services/capabilityTokenIssuer';
import { ScopeViolationError } from '../../services/scopeEnforcement';

/**
 * POST /api/agent-runtime/tokens — mints a capability token.
 * Body: { run_id, agent_id, acting_persona_id, tool_sku, args, tenant_scope, ttl_seconds? }
 * Returns: { success: true, data: { token_id, expires_at, signature } }
 */
export async function mintHandler(
  req: FastifyRequest<{ Body: MintInput }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (
    !body?.run_id ||
    !body?.agent_id ||
    !body?.acting_persona_id ||
    !body?.tool_sku ||
    body?.args === undefined ||
    !body?.tenant_scope
  ) {
    reply.code(400).send({
      success: false,
      error: 'Missing required field: run_id, agent_id, acting_persona_id, tool_sku, args, tenant_scope are required',
    });
    return;
  }
  try {
    const minted = await mintToken(body);
    reply.code(201).send({ success: true, data: minted });
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      reply.code(403).send({
        success: false,
        error: 'scope_violation',
        data: {
          requested_sku: err.requested_sku,
          agent_id: err.agent_id,
          exception_id: err.exception_id,
          approval_request_id: err.approval_request_id,
        },
      });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Mint failed' });
  }
}

interface ValidateBody {
  args: unknown;
}

interface TokenIdParams {
  token_id: string;
}

/**
 * POST /api/agent-runtime/tokens/:token_id/validate — checks expiry,
 * single-use status, revocation, args binding, signature.
 */
export async function validateHandler(
  req: FastifyRequest<{ Params: TokenIdParams; Body: ValidateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { token_id } = req.params;
  const body = req.body;
  if (!token_id) {
    reply.code(400).send({ success: false, error: 'Missing path param: token_id' });
    return;
  }
  if (body?.args === undefined) {
    reply.code(400).send({ success: false, error: 'Missing required field: args' });
    return;
  }
  try {
    const result = await validateToken(token_id, body.args);
    if (result.valid) {
      reply.code(200).send({
        success: true,
        data: {
          valid: true,
          tool_sku: result.token.tool_sku,
          expires_at: result.token.expires_at.toISOString(),
        },
      });
    } else {
      reply.code(200).send({ success: true, data: { valid: false, reason: result.reason } });
    }
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Validate failed' });
  }
}

interface RevokeBody {
  reason: string;
  actor_id?: string;
  actor_kind?: 'human' | 'service' | 'agent';
}

/**
 * POST /api/agent-runtime/tokens/:token_id/revoke — marks revoked + emits
 * audit. Idempotent. In-flight tools polling isRevoked() see the new state
 * within their next poll cycle (mid-flight cancellation per FR-ART-4).
 */
export async function revokeHandler(
  req: FastifyRequest<{ Params: TokenIdParams; Body: RevokeBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { token_id } = req.params;
  const body = req.body;
  if (!token_id) {
    reply.code(400).send({ success: false, error: 'Missing path param: token_id' });
    return;
  }
  if (!body?.reason || typeof body.reason !== 'string') {
    reply.code(400).send({ success: false, error: 'Missing required field: reason' });
    return;
  }
  const actor = req.auth?.sub ?? body.actor_id ?? 'system';
  try {
    await revokeToken({
      token_id,
      reason: body.reason,
      actor_id: actor,
      actor_kind: body.actor_kind ?? 'human',
    });
    reply.code(200).send({ success: true, data: { token_id, revoked: true } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Revoke failed' });
  }
}
