import { FastifyReply, FastifyRequest } from 'fastify';
import { retrieveSecret, rotateSecret, storeSecret } from '../../services/secretLifecycle';
import { validateRegisterInput } from '../../validators/secretValidator';

/**
 * POST /api/secrets — registers a new SecretRef in the catalog.
 */
export async function storeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateRegisterInput(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const record = await storeSecret(validation.value);
    reply.code(201).send({ data: record });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Invalid secret reference')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * GET /api/secrets/:ref — looks up a SecretRef by ref string (URL-encoded).
 */
export async function retrieveHandler(req: FastifyRequest<{ Params: { ref: string } }>, reply: FastifyReply): Promise<void> {
  try {
    const ref = decodeURIComponent(req.params.ref);
    const record = await retrieveSecret(ref);
    if (!record) {
      reply.code(404).send({ error: 'NotFound', details: [`No SecretRef registered for ${ref}`] });
      return;
    }
    reply.code(200).send({ data: record });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/secrets/:ref/rotate — rotates the underlying KMS key version
 * and updates rotated_at on the SecretRef.
 */
export async function rotateHandler(req: FastifyRequest<{ Params: { ref: string } }>, reply: FastifyReply): Promise<void> {
  try {
    const ref = decodeURIComponent(req.params.ref);
    const result = await rotateSecret(ref);
    reply.code(200).send({ data: result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Secret reference not registered')) {
      reply.code(404).send({ error: 'NotFound', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
