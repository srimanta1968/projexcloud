import { FastifyReply, FastifyRequest } from 'fastify';
import {
  bulkItemError,
  bulkResponse,
  parseBulkEnvelope,
  type BulkItemResult,
} from '@projexlight/contracts';
import {
  CrossBorderError,
  checkConsent,
  checkConsentBulk,
  exportReceipts,
  grantConsent,
  listPurposes,
  listTenantReceipts,
  registerPurpose,
  revokeConsent,
  type BulkCheckItem,
} from '../../services/consentService';
import type { CheckConsentResult } from '../../models/consent.model';
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
    // Read from the credential, NOT from the validated body. A body field named
    // authenticated_principal would be trivially forgeable and worse than absent.
    const revocation = await revokeConsent(req.params.receipt_id, {
      ...validation.value,
      authenticated_principal: req.auth?.primary_persona_id ?? req.auth?.sub ?? undefined,
      authenticated_actor_kind: req.auth?.actor?.kind === 'service' ? 'service' : 'human',
    });
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
 * GET /api/consents/purposes — reads the purpose registry that
 * POST /api/consents/purposes writes into.
 *
 * Its absence blocked three separate things downstream: a consent screen's
 * taxonomy panel had nothing to render, a signature-encryption path could not be
 * exercised end to end because issuing a real receipt needs a valid registered
 * purpose_id and none could be discovered, and a decision engine was populating a
 * purpose enum from a mockup. All three needed the same list.
 */
export async function listPurposesHandler(
  req: FastifyRequest<{ Querystring: { app_id?: string; category?: string; legal_basis?: string; limit?: string; offset?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const q = req.query ?? {};
  const limit = q.limit === undefined ? undefined : Number(q.limit);
  const offset = q.offset === undefined ? undefined : Number(q.offset);
  if ((limit !== undefined && !Number.isFinite(limit)) || (offset !== undefined && !Number.isFinite(offset))) {
    reply.code(400).send({ error: 'ValidationError', details: ['limit and offset must be numbers'] });
    return;
  }
  try {
    const result = await listPurposes({
      app_id: q.app_id,
      category: q.category,
      legal_basis: q.legal_basis,
      limit,
      offset,
    });
    reply.code(200).send({ data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * POST /api/consents/check/bulk — the four-tuple check for N subjects in one
 * request and one query.
 *
 * Per-item validation happens HERE rather than in the service, because a rejected
 * item must keep its slot: the caller zips these verdicts back onto its own
 * subject list, and an item that vanished would shift every verdict after it.
 */
export async function checkConsentBulkHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const envelope = parseBulkEnvelope(req.body);
  if (!envelope.ok) {
    reply.code(400).send({ error: envelope.error, details: envelope.details });
    return;
  }

  const valid: BulkCheckItem[] = [];
  const results: BulkItemResult<CheckConsentResult>[] = [];
  envelope.items.forEach((raw, index) => {
    const validation = validateCheckConsent(raw);
    if (!validation.ok) {
      results.push(bulkItemError(index, 'VALIDATION_ERROR', validation.errors.join('; ')));
      return;
    }
    valid.push({ ...validation.value, index });
  });

  try {
    const rows = await checkConsentBulk(valid);
    for (const row of rows) {
      const { index, ...verdict } = row;
      results.push({ index, ok: true, ...verdict });
    }
    // Restore the caller's order — validation failures were collected first, and
    // the query returns only the rows it was given.
    results.sort((a, b) => a.index - b.index);
    reply.code(200).send({ data: bulkResponse(results) });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * The tenant this credential speaks for, or a refusal.
 *
 * 403 rather than a tenant-less read, which is the rule the point-read route
 * already follows: a receipt names a person and a purpose, so a query with no
 * scope is not a broad answer, it is somebody else's answer.
 */
function tenantOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const tenant_id = req.auth?.tenant_id ?? '';
  if (!tenant_id) {
    reply.code(403).send({
      success: false,
      error: 'This token carries no tenant, so no receipt scope can be derived',
    });
    return null;
  }
  return tenant_id;
}

/**
 * GET /api/consents/export?person_id= — the Article-15 export for ONE subject,
 * within the caller's tenant.
 *
 * PERSON_ID IS REQUIRED NOW. It was optional, and omitting it exported every
 * tenant's receipts; the shape of the mistake was that "export" with no argument
 * had a meaning at all. A caller that wants its own register wants
 * GET /api/consents/receipts, which is a different question and says so.
 */
export async function exportReceiptsHandler(
  req: FastifyRequest<{ Querystring: { person_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;

  const person_id = (req.query.person_id ?? '').trim();
  if (!person_id) {
    reply.code(400).send({
      error: 'ValidationError',
      details: ['person_id is required — this endpoint answers a subject access request'],
    });
    return;
  }

  try {
    const receipts = await exportReceipts(tenant_id, person_id);
    reply.code(200).send({ data: { receipts } });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/**
 * GET /api/consents/receipts — the caller tenant's receipt register, paged.
 *
 * The list a controller needs to see what it holds, which until now did not
 * exist and was approximated from the DSAR export above.
 */
export async function listReceiptsHandler(
  req: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = tenantOf(req, reply);
  if (!tenant_id) return;

  const asInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  try {
    const page = await listTenantReceipts({
      tenant_id,
      limit: asInt(req.query.limit),
      offset: asInt(req.query.offset),
    });
    reply.code(200).send({ data: page });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
