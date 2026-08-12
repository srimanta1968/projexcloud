import { FastifyReply, FastifyRequest } from 'fastify';
import {
  bulkItemError,
  bulkResponse,
  parseBulkEnvelope,
  type BulkItemResult,
} from '@projexlight/contracts';
import {
  createPolicy,
  evaluatePolicy,
  evaluatePolicyBulk,
  getPolicy,
  type BulkEvaluateItem,
} from '../../services/policyService';
import type { EvaluatePolicyResult } from '../../models/policy.model';
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

/**
 * POST /api/policies/evaluate/bulk — N evaluations, one request.
 *
 * An item naming an absent policy reports POLICY_NOT_FOUND in its own slot
 * rather than 404-ing the request, which is the difference between "one of your
 * ten thousand subjects referenced a deleted policy" and "your campaign check
 * failed".
 */
export async function evaluatePolicyBulkHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const envelope = parseBulkEnvelope(req.body);
  if (!envelope.ok) {
    reply.code(400).send({ error: envelope.error, details: envelope.details });
    return;
  }

  const valid: BulkEvaluateItem[] = [];
  const results: BulkItemResult<{ result: EvaluatePolicyResult }>[] = [];
  envelope.items.forEach((raw, index) => {
    const validation = validateEvaluatePolicy(raw);
    if (!validation.ok) {
      results.push(bulkItemError(index, 'VALIDATION_ERROR', validation.errors.join('; ')));
      return;
    }
    valid.push({ ...validation.value, index });
  });

  try {
    for (const outcome of await evaluatePolicyBulk(valid)) {
      results.push(
        outcome.ok
          ? { index: outcome.index, ok: true, result: outcome.result }
          : bulkItemError(outcome.index, outcome.error_code, outcome.error),
      );
    }
    results.sort((a, b) => a.index - b.index);
    reply.code(200).send({ data: bulkResponse(results) });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
