import { FastifyReply, FastifyRequest } from 'fastify';
import type { ProviderId } from '@projexlight/contracts';
import {
  bindTenantCredential,
  rotateTenantCredential,
  revokeTenantCredential,
  listTenantCredentials,
} from '../../services/tenantCredentialService';

const SUPPORTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['anthropic', 'openai', 'bedrock', 'gemini']);

interface BindBody {
  tenant_id: string;
  provider_id: ProviderId;
  raw_key: string;
  model_allowlist?: string[];
  fallback_on_error?: boolean;
}

interface RotateBody {
  raw_key: string;
}

interface RevokeBody {
  reason: string;
}

interface AuthedRequest {
  user?: { sub?: string; tenant_id?: string; persona_id?: string };
}

function actorIdFrom(req: FastifyRequest): string {
  const authed = req as unknown as AuthedRequest;
  return authed.user?.persona_id || authed.user?.sub || 'tenant-admin-ui';
}

/**
 * POST /api/ai-gateway/tenant-credentials — bind a tenant's provider key.
 * Body: { tenant_id, provider_id, raw_key, model_allowlist?, fallback_on_error? }
 * Response shape never includes raw_key or credential_envelope.
 */
export async function bindCredentialHandler(
  req: FastifyRequest<{ Body: BindBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.tenant_id || !body?.provider_id || !body?.raw_key) {
    reply.code(400).send({ success: false, error: 'tenant_id, provider_id, raw_key are required' });
    return;
  }
  if (!SUPPORTED_PROVIDERS.has(body.provider_id)) {
    reply.code(400).send({ success: false, error: `unsupported provider_id: ${body.provider_id}` });
    return;
  }
  if (typeof body.raw_key !== 'string' || body.raw_key.length < 8) {
    reply.code(400).send({ success: false, error: 'raw_key must be a non-trivial string' });
    return;
  }
  try {
    const binding = await bindTenantCredential({
      tenant_id: body.tenant_id,
      provider_id: body.provider_id,
      raw_key: body.raw_key,
      model_allowlist: body.model_allowlist,
      fallback_on_error: body.fallback_on_error,
      actor_id: actorIdFrom(req),
    });
    reply.code(201).send({ success: true, data: { binding } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: (err as Error).message || 'bind failed' });
  }
}

/**
 * PATCH /api/ai-gateway/tenant-credentials/:binding_id — rotate the raw key
 * on an existing active binding. binding_id and bound_at are preserved.
 */
export async function rotateCredentialHandler(
  req: FastifyRequest<{ Params: { binding_id: string }; Body: RotateBody }>,
  reply: FastifyReply,
): Promise<void> {
  const binding_id = req.params.binding_id;
  const body = req.body;
  if (!binding_id) {
    reply.code(400).send({ success: false, error: 'binding_id path param is required' });
    return;
  }
  if (!body?.raw_key || body.raw_key.length < 8) {
    reply.code(400).send({ success: false, error: 'raw_key must be a non-trivial string' });
    return;
  }
  try {
    const binding = await rotateTenantCredential({
      binding_id,
      raw_key: body.raw_key,
      actor_id: actorIdFrom(req),
    });
    reply.code(200).send({ success: true, data: { binding } });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: msg || 'rotate failed' });
  }
}

/**
 * DELETE /api/ai-gateway/tenant-credentials/:binding_id — revoke an active
 * binding. Reason min length 6 to match the CMEK BYOK revoke pattern.
 */
export async function revokeCredentialHandler(
  req: FastifyRequest<{ Params: { binding_id: string }; Body: RevokeBody }>,
  reply: FastifyReply,
): Promise<void> {
  const binding_id = req.params.binding_id;
  const body = req.body;
  if (!binding_id) {
    reply.code(400).send({ success: false, error: 'binding_id path param is required' });
    return;
  }
  if (!body?.reason || body.reason.trim().length < 6) {
    reply.code(400).send({ success: false, error: 'reason must be at least 6 characters' });
    return;
  }
  try {
    const binding = await revokeTenantCredential({
      binding_id,
      reason: body.reason,
      actor_id: actorIdFrom(req),
    });
    reply.code(200).send({ success: true, data: { binding } });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: msg || 'revoke failed' });
  }
}

/**
 * GET /api/ai-gateway/tenant-credentials?tenant_id=... — list bindings.
 * Returns last_4 + lifecycle metadata. Never returns credential_envelope.
 */
export async function listCredentialsHandler(
  req: FastifyRequest<{ Querystring: { tenant_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = req.query.tenant_id;
  if (!tenant_id) {
    reply.code(400).send({ success: false, error: 'tenant_id query param is required' });
    return;
  }
  try {
    const bindings = await listTenantCredentials({ tenant_id });
    reply.code(200).send({ success: true, data: { bindings } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'list failed' });
  }
}
