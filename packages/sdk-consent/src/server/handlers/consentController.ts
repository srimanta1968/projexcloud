import { FastifyReply, FastifyRequest } from 'fastify';
import {
  CrossBorderError,
  checkConsent,
  exportReceipts,
  grantConsent,
  registerPurpose,
  revokeConsent,
} from '../../services/consentService';
import {
  validateCheckConsent,
  validateGrantConsent,
  validateRegisterPurpose,
  validateRevokeConsent,
} from '../../validators/consentValidator';

/**
 * POST /api/consents/purposes — registers a typed purpose in the per-app
 * registry (FR-CNS-4). Emits consent.purpose.registered.v1.
 */
export async function registerPurposeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateRegisterPurpose(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const purpose = await registerPurpose(validation.value);
    reply.code(201).send({ data: { purpose } });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('duplicate key')) {
      reply.code(409).send({ error: 'Conflict', details: ['purpose_id already registered'] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/consents — grants a new consent receipt (FR-CNS-1).
 */
export async function grantConsentHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateGrantConsent(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const receipt = await grantConsent(validation.value);
    reply.code(201).send({ data: { receipt } });
  } catch (err) {
    if (err instanceof CrossBorderError) {
      // HTTP 451 Unavailable For Legal Reasons — closest match for a
      // jurisdictional refusal per FR-CNS-5.
      reply.code(451).send({ error: err.code, details: [err.message] });
      return;
    }
    const msg = (err as Error).message;
    if (msg.includes('duplicate key')) {
      reply.code(409).send({ error: 'Conflict', details: ['Active receipt already exists for this tuple'] });
      return;
    }
    if (msg.includes('violates foreign key')) {
      reply.code(400).send({ error: 'ValidationError', details: ['purpose_id does not exist'] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/consents/:receipt_id/revoke — appends a revocation row and
 * stamps the parent receipt (FR-CNS-2).
 */
export async function revokeConsentHandler(
  req: FastifyRequest<{ Params: { receipt_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const validation = validateRevokeConsent(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const revocation = await revokeConsent(req.params.receipt_id, validation.value);
    reply.code(200).send({ data: { revocation } });
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
 * POST /api/consents/check — returns the consent state for a tuple. Used by
 * every downstream SDK before processing PII (FR-CNS-1, FR-CNS-5).
 */
export async function checkConsentHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateCheckConsent(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }
  try {
    const result = await checkConsent(validation.value);
    reply.code(200).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * GET /api/consents/export — exports all receipts (optionally for one person)
 * as JSONL-friendly array.
 */
export async function exportReceiptsHandler(
  req: FastifyRequest<{ Querystring: { person_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const receipts = await exportReceipts(req.query.person_id);
    reply.code(200).send({ data: { receipts } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
