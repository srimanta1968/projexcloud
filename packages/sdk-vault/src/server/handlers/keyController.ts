import { FastifyReply, FastifyRequest } from 'fastify';
import { issueKey, rotateKey, shredKey, type OperatorContext } from '../../services/keyService';
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
 * POST /api/vault/keys — issues a new vault.key at the requested tier.
 */
export async function issueHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateIssueKey(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const key = await issueKey(
      {
        tier: validation.value.tier,
        scope_id: validation.value.scope_id ?? null,
        parent_key_id: validation.value.parent_key_id ?? null,
        kms_ref: validation.value.kms_ref,
        algorithm: validation.value.algorithm,
        tenant_id: validation.value.tenant_id ?? null,
        region: validation.value.region,
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
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

interface KeyIdParams {
  key_id: string;
}

/**
 * POST /api/vault/keys/:key_id/rotate — rotates a key.
 */
export async function rotateHandler(req: FastifyRequest<{ Params: KeyIdParams; Body: { reason?: string } }>, reply: FastifyReply): Promise<void> {
  try {
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
