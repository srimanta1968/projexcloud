import { FastifyReply, FastifyRequest } from 'fastify';
import { getKeyForOperator, getKeyForTenant, issueKey, PLATFORM_TIERS, rotateKey, shredKey, type OperatorContext } from '../../services/keyService';
import { envelopeDecrypt, envelopeEncrypt } from '@projexlight/sdk-secrets';
import {
  validateEnvelopeDecrypt,
  validateEnvelopeEncrypt,
  validateIssueKey,
} from '../../validators/keyValidator';

function operatorFromReq(req: FastifyRequest): OperatorContext {
  return { kind: 'human', id: req.auth?.sub ?? 'unknown' };
}

/**
 * POST /api/vault/keys — a TENANT issues a key in ITS OWN hierarchy.
 *
 * The tenant comes from the token, never the body: the body's tenant_id used to be trusted,
 * so any tenant could file keys under another tenant or none. Platform tiers (root, app,
 * pool) wrap every tenant and are an operator's (POST /admin/vault/keys) — a tenant token
 * could previously mint them. The parent must be the tenant's own key, or for the tenant
 * tier itself a platform key (that is where a tenant's hierarchy hangs).
 */
export async function issueHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateIssueKey(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  const tenantId = req.auth?.tenant_id ?? '';
  if (!tenantId) {
    reply.code(403).send({ error: 'Forbidden', details: ['this token carries no tenant, so no key scope can be derived'] });
    return;
  }
  const v = validation.value;
  if ((PLATFORM_TIERS as readonly string[]).includes(v.tier)) {
    reply.code(403).send({ error: 'PlatformTier', details: [`${v.tier} keys wrap every tenant and are issued by an operator (POST /admin/vault/keys)`] });
    return;
  }
  if (v.tenant_id && v.tenant_id !== tenantId) {
    reply.code(403).send({ error: 'Forbidden', details: ['tenant_id does not match the authenticated tenant'] });
    return;
  }
  if (v.tier === 'tenant' && v.scope_id && v.scope_id !== tenantId) {
    reply.code(400).send({ error: 'ValidationError', details: ["a tenant-tier key's scope_id is the tenant itself"] });
    return;
  }
  if (v.parent_key_id) {
    const parent = await getKeyForOperator(v.parent_key_id);
    const own = parent?.tenant_id === tenantId;
    const platformParentOfTenantKey = v.tier === 'tenant' && parent !== null && parent.tenant_id === null
      && (PLATFORM_TIERS as readonly string[]).includes(parent.tier);
    if (!parent || !(own || platformParentOfTenantKey)) {
      reply.code(404).send({ error: 'NotFound', details: ['parent key not found'] });
      return;
    }
  }
  try {
    const key = await issueKey(
      {
        tier: v.tier,
        scope_id: v.tier === 'tenant' ? tenantId : v.scope_id ?? null,
        parent_key_id: v.parent_key_id ?? null,
        kms_ref: v.kms_ref,
        algorithm: v.algorithm,
        tenant_id: tenantId,
        region: v.region,
      },
      operatorFromReq(req),
    );
    reply.code(201).send({ data: key });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Invalid parent tier') || msg.includes('Parent key')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    // One active tenant-tier key per tenant (unique partial index, vault migration 004).
    if ((err as { code?: string }).code === '23505') {
      reply.code(409).send({ error: 'Conflict', details: ['this tenant already has an active tenant-tier key; rotate it instead'] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * A tenant route may only touch the caller's own keys. Another tenant's key — or a platform
 * key, which has no tenant — answers 404 (never 403: that would confirm the id exists).
 * Without this, any tenant token could rotate or SHRED any key by id, a root key included.
 */
async function ownKeyOr404(req: FastifyRequest<{ Params: KeyIdParams }>, reply: FastifyReply): Promise<boolean> {
  const tenantId = req.auth?.tenant_id ?? '';
  const key = tenantId ? await getKeyForTenant(req.params.key_id, tenantId).catch(() => null) : null;
  if (!key) {
    reply.code(404).send({ error: 'NotFound', details: ['key not found'] });
    return false;
  }
  return true;
}

interface KeyIdParams {
  key_id: string;
}

/**
 * POST /api/vault/keys/:key_id/rotate — rotates a key.
 */
export async function rotateHandler(req: FastifyRequest<{ Params: KeyIdParams; Body: { reason?: string } }>, reply: FastifyReply): Promise<void> {
  try {
    if (!(await ownKeyOr404(req, reply))) return;
    const reason = req.body?.reason;
    const key = await rotateKey(req.params.key_id, operatorFromReq(req), reason);
    reply.code(200).send({ data: key });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('not in a rotatable')) {
      reply.code(404).send({ error: 'NotFound', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/vault/keys/:key_id/shred — cryptographic-shred. Requires reason.
 */
export async function shredHandler(req: FastifyRequest<{ Params: KeyIdParams; Body: { reason?: string } }>, reply: FastifyReply): Promise<void> {
  try {
    const reason = req.body?.reason ?? '';
    if (!reason) {
      reply.code(400).send({ error: 'ValidationError', details: ['reason is required for shred'] });
      return;
    }
    if (!(await ownKeyOr404(req, reply))) return;
    const key = await shredKey(req.params.key_id, operatorFromReq(req), reason);
    reply.code(200).send({ data: key });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('already shredded')) {
      reply.code(404).send({ error: 'NotFound', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/vault/encrypt — envelope-encrypts a base64 plaintext under the
 * SecretRef's KMS key. Returns base64 bundle.
 */
export async function encryptHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateEnvelopeEncrypt(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const plaintext = Buffer.from(validation.value.plaintext_b64, 'base64');
    const result = await envelopeEncrypt(validation.value.ref, plaintext);
    reply.code(200).send({ data: result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Secret reference not registered') || msg.startsWith('Invalid secret reference')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/vault/decrypt — reverses envelope encrypt.
 */
export async function decryptHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateEnvelopeDecrypt(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const plaintext = await envelopeDecrypt(validation.value);
    reply.code(200).send({ data: { plaintext_b64: plaintext.toString('base64') } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Secret reference not registered') || msg.startsWith('Invalid secret reference')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * Operator (ADMIN_OPS_TOKEN) issue: any tier, including the platform tiers a tenant cannot
 * mint. tenant_id comes from the body and is required below the platform tiers. The caller
 * (an admin-guarded gateway route) has already checked the ops token.
 */
export async function operatorIssueHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateIssueKey(req.body);
  if (!validation.ok) {
    reply.code(400).send({ success: false, error: 'ValidationError', details: validation.errors });
    return;
  }
  const v = validation.value;
  const platform = (PLATFORM_TIERS as readonly string[]).includes(v.tier);
  if (platform && v.tenant_id) {
    reply.code(400).send({ success: false, error: 'ValidationError', details: [`${v.tier} keys belong to no tenant; omit tenant_id`] });
    return;
  }
  if (!platform && !v.tenant_id) {
    reply.code(400).send({ success: false, error: 'ValidationError', details: [`tenant_id is required for a ${v.tier} key`] });
    return;
  }
  try {
    const key = await issueKey({
      tier: v.tier, scope_id: v.scope_id ?? null, parent_key_id: v.parent_key_id ?? null, kms_ref: v.kms_ref,
      algorithm: v.algorithm, tenant_id: platform ? null : v.tenant_id ?? null, region: v.region,
    }, { kind: 'service', id: 'admin-ops' });
    reply.code(201).send({ success: true, data: key });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Invalid parent tier') || msg.includes('Parent key')) {
      reply.code(400).send({ success: false, error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'InternalError' });
  }
}

/** Operator rotate of any key (the platform console rotates root/app/pool keys). No operator shred, by design. */
export async function operatorRotateHandler(req: FastifyRequest<{ Params: KeyIdParams; Body: { reason?: string } }>, reply: FastifyReply): Promise<void> {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      reply.code(400).send({ success: false, error: 'ValidationError', details: ['reason is required'] });
      return;
    }
    const key = await rotateKey(req.params.key_id, { kind: 'service', id: 'admin-ops' }, reason);
    reply.code(200).send({ success: true, data: key });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('not in a rotatable')) {
      reply.code(404).send({ success: false, error: 'NotFound', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'InternalError' });
  }
}
