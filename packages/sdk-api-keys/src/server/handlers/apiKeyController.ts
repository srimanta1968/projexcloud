import { FastifyReply, FastifyRequest } from 'fastify';
import { issueKey, listKeys, revokeKey, rotateKey } from '../../services/apiKeyService';
import { validateIssueKey } from '../../validators/apiKeyValidator';

/** POST /api/api-keys — issue a new key for a tenant (FR-APK-1,2). */
export async function issueKeyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateIssueKey(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await issueKey(validation.value);
    reply.code(201).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** GET /api/api-keys?tenant_id=... — list keys for a tenant (FR-APK-2,6). */
export async function listKeysHandler(
  req: FastifyRequest<{ Querystring: { tenant_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = (req.query.tenant_id ?? '').trim();
  if (!tenant_id) {
    reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param is required'] });
    return;
  }
  try {
    const keys = await listKeys(tenant_id);
    reply.code(200).send({ data: { keys } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/api-keys/:key_id/revoke — immediate revocation (FR-APK-5). */
export async function revokeKeyHandler(
  req: FastifyRequest<{ Params: { key_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const key = await revokeKey(req.params.key_id);
    if (!key) {
      reply.code(404).send({ error: 'NotFound', details: [`No active key with id ${req.params.key_id}`] });
      return;
    }
    reply.code(200).send({ data: { key } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/api-keys/:key_id/rotate — rotate with 24h grace (FR-APK-4). */
export async function rotateKeyHandler(
  req: FastifyRequest<{ Params: { key_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const result = await rotateKey(req.params.key_id);
    if (!result) {
      reply.code(404).send({ error: 'NotFound', details: [`No rotatable key with id ${req.params.key_id}`] });
      return;
    }
    reply.code(201).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
