import { FastifyReply, FastifyRequest } from 'fastify';
import {
  checkRelationship,
  createRelationship,
  updateRelationshipScope,
} from '../../services/rebacService';
import {
  validateCheckRelationship,
  validateCreateRelationship,
  validateUpdateScope,
} from '../../validators/rebacValidator';

/** POST /api/relationships — creates a new edge (FR-REB-1). */
export async function createRelationshipHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateCreateRelationship(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const relationship = await createRelationship(validation.value);
    reply.code(201).send({ data: { relationship } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('check constraint')) {
      reply.code(400).send({ error: 'ValidationError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** PUT /api/relationships/:relationship_id/scope — change scope/status (FR-REB-4). */
export async function updateScopeHandler(
  req: FastifyRequest<{ Params: { relationship_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const validation = validateUpdateScope(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const relationship = await updateRelationshipScope(req.params.relationship_id, validation.value);
    reply.code(200).send({ data: { relationship } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ error: 'NotFound', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/relationships/check — ReBAC decision with traversal budget (FR-REB-2,6). */
export async function checkRelationshipHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateCheckRelationship(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await checkRelationship(validation.value);
    reply.code(200).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
