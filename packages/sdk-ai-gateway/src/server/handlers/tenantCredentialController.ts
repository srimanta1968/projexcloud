import { FastifyReply, FastifyRequest } from 'fastify';
import {
  CREDENTIAL_LAYERS,
  CREDENTIAL_PRIORITIES,
  LAYER_PROVIDERS,
  bindTenantCredential,
  rotateTenantCredential,
  revokeTenantCredential,
  listTenantCredentials,
  type CredentialLayer,
  type CredentialPriority,
} from '../../services/tenantCredentialService';

interface BindBody {
  tenant_id?: string;
  provider_id: string;
  /** Voice layer the key serves (default llm). */
  layer?: string;
  /** primary | secondary (default primary). */
  priority?: string;
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
  auth?: { sub?: string; tenant_id?: string | null; primary_persona_id?: string | null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorIdFrom(req: FastifyRequest): string {
  const auth = (req as unknown as AuthedRequest).auth;
  return auth?.primary_persona_id || auth?.sub || 'tenant-admin-ui';
}

/**
 * The tenant a credential request acts for, or null after sending the error reply.
 * The authenticated tenant is authoritative: an explicit tenant_id is accepted only
 * when it matches, so one tenant's token can never list, bind, rotate or revoke
 * another tenant's keys.
 */
function tenantOf(req: FastifyRequest, reply: FastifyReply, explicit?: unknown): string | null {
  const authTenant = (req as unknown as AuthedRequest).auth?.tenant_id ?? null;
  const given = typeof explicit === 'string' && explicit.length > 0 ? explicit : null;
  if (given && authTenant && given !== authTenant) {
    reply.code(403).send({ success: false, error: 'tenant_id does not match the authenticated tenant' });
    return null;
  }
  const tenantId = given ?? authTenant;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    reply.code(400).send({ success: false, error: 'tenant_id is required' });
    return null;
  }
  return tenantId;
}

/**
 * Logs a failure WITHOUT the request: bodies carry raw keys, so only the error message
 * (which never contains key material) is logged.
 */
function logFailure(req: FastifyRequest, what: string, err: unknown): void {
  req.log.error({ err_message: (err as Error)?.message }, `[ai-gateway.byok] ${what} failed`);
}

/**
 * POST /api/ai-gateway/tenant-credentials — bind a tenant's provider key for a layer.
 * Body: { tenant_id?, provider_id, layer?, priority?, raw_key, model_allowlist?, fallback_on_error? }
 * The response is a reference (binding_id + last_4 + metadata): never raw_key or the envelope.
 */
export async function bindCredentialHandler(
  req: FastifyRequest<{ Body: BindBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.provider_id || !body?.raw_key) {
    reply.code(400).send({ success: false, error: 'tenant_id, provider_id, raw_key are required' });
    return;
  }
  const tenantId = tenantOf(req, reply, body.tenant_id);
  if (!tenantId) return;
  const layer = body.layer ?? 'llm';
  const priority = body.priority ?? 'primary';
  if (!(CREDENTIAL_LAYERS as readonly string[]).includes(layer)) {
    reply.code(400).send({ success: false, error: `layer must be one of ${CREDENTIAL_LAYERS.join(', ')}` });
    return;
  }
  if (!(CREDENTIAL_PRIORITIES as readonly string[]).includes(priority)) {
    reply.code(400).send({ success: false, error: 'priority must be primary or secondary' });
    return;
  }
  if (!LAYER_PROVIDERS[layer as CredentialLayer].includes(body.provider_id)) {
    reply.code(400).send({ success: false, error: `unsupported provider_id: ${body.provider_id} for layer ${layer}` });
    return;
  }
  if (typeof body.raw_key !== 'string' || body.raw_key.length < 8) {
    reply.code(400).send({ success: false, error: 'raw_key must be a non-trivial string' });
    return;
  }
  try {
    const binding = await bindTenantCredential({
      tenant_id: tenantId,
      provider_id: body.provider_id,
      layer: layer as CredentialLayer,
      priority: priority as CredentialPriority,
      raw_key: body.raw_key,
      model_allowlist: body.model_allowlist,
      fallback_on_error: body.fallback_on_error,
      actor_id: actorIdFrom(req),
    });
    reply.code(201).send({ success: true, data: { binding } });
  } catch (err) {
    logFailure(req, 'bind', err);
    reply.code(500).send({ success: false, error: 'bind failed' });
  }
}

/**
 * PATCH /api/ai-gateway/tenant-credentials/:binding_id — rotate the raw key on one of the
 * tenant's active bindings. binding_id and bound_at are preserved.
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
  if (!body?.raw_key || typeof body.raw_key !== 'string' || body.raw_key.length < 8) {
    reply.code(400).send({ success: false, error: 'raw_key must be a non-trivial string' });
    return;
  }
  const tenantId = tenantOf(req, reply);
  if (!tenantId) return;
  if (!UUID_RE.test(binding_id)) {
    reply.code(404).send({ success: false, error: `active binding not found: ${binding_id}` });
    return;
  }
  try {
    const binding = await rotateTenantCredential({
      tenant_id: tenantId,
      binding_id,
      raw_key: body.raw_key,
      actor_id: actorIdFrom(req),
    });
    reply.code(200).send({ success: true, data: { binding } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    logFailure(req, 'rotate', err);
    reply.code(500).send({ success: false, error: 'rotate failed' });
  }
}

/**
 * DELETE /api/ai-gateway/tenant-credentials/:binding_id — revoke one of the tenant's
 * active bindings (reason ≥ 6 chars, matching the CMEK BYOK revoke pattern). Emits
 * ai_gateway.tenant_credential.revoked.v1 and voice.credential.degraded.v1.
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
  if (!body?.reason || typeof body.reason !== 'string' || body.reason.trim().length < 6) {
    reply.code(400).send({ success: false, error: 'reason must be at least 6 characters' });
    return;
  }
  const tenantId = tenantOf(req, reply);
  if (!tenantId) return;
  if (!UUID_RE.test(binding_id)) {
    reply.code(404).send({ success: false, error: `active binding not found: ${binding_id}` });
    return;
  }
  try {
    const binding = await revokeTenantCredential({
      tenant_id: tenantId,
      binding_id,
      reason: body.reason,
      actor_id: actorIdFrom(req),
    });
    reply.code(200).send({ success: true, data: { binding } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    logFailure(req, 'revoke', err);
    reply.code(500).send({ success: false, error: 'revoke failed' });
  }
}

/**
 * GET /api/ai-gateway/tenant-credentials?tenant_id=&layer=&status= — the tenant's
 * bindings, newest first. Returns last_4 + lifecycle and capacity metadata only.
 */
export async function listCredentialsHandler(
  req: FastifyRequest<{ Querystring: { tenant_id?: string; layer?: string; status?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenantId = tenantOf(req, reply, req.query.tenant_id);
  if (!tenantId) return;
  const { layer, status } = req.query;
  if (layer !== undefined && !(CREDENTIAL_LAYERS as readonly string[]).includes(layer)) {
    reply.code(400).send({ success: false, error: `layer must be one of ${CREDENTIAL_LAYERS.join(', ')}` });
    return;
  }
  if (status !== undefined && status !== 'active' && status !== 'revoked') {
    reply.code(400).send({ success: false, error: 'status must be active or revoked' });
    return;
  }
  try {
    const bindings = await listTenantCredentials({
      tenant_id: tenantId,
      layer: layer as CredentialLayer | undefined,
      status: status as 'active' | 'revoked' | undefined,
    });
    reply.code(200).send({ success: true, data: { bindings } });
  } catch (err) {
    logFailure(req, 'list', err);
    reply.code(500).send({ success: false, error: 'list failed' });
  }
}
