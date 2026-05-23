import { FastifyReply, FastifyRequest } from 'fastify';
import { createPolicy, evaluatePolicy, getPolicy } from '../../services/policyService';
import { validateCreatePolicy, validateEvaluatePolicy } from '../../validators/policyValidator';

/** POST /api/policies — create a versioned policy bundle (FR-POL-4). */
export async function createPolicyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateCreatePolicy(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const policy = await createPolicy(validation.value);
    reply.code(201).send({ data: { policy } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('duplicate key')) {
      reply.code(409).send({ error: 'Conflict', details: ['policy with this name+version already exists'] });
      return;
    }
    if (msg.startsWith('Unknown IQL') || msg.startsWith('Unexpected') || msg.includes('IQL')) {
      reply.code(400).send({ error: 'IQLParseError', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** GET /api/policies/:policy_id — read one policy bundle. */
export async function getPolicyHandler(
  req: FastifyRequest<{ Params: { policy_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const policy = await getPolicy(req.params.policy_id);
    if (!policy) {
      reply.code(404).send({ error: 'NotFound', details: [`No policy ${req.params.policy_id}`] });
      return;
    }
    reply.code(200).send({ data: { policy } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** POST /api/policies/evaluate — evaluate a policy with subject + context (FR-POL-1). */
export async function evaluatePolicyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateEvaluatePolicy(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await evaluatePolicy(validation.value);
    reply.code(200).send({ data: result });
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
