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
import { closeContextualRole, grantContextualRole, listContextualRoles, attestContextualRole, TRUST_STATES, type TrustState } from '../../services/contextualRoleService';

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
  /*
   * P16 EP-384 — the same endpoint can now CLOSE a relationship by setting valid_to
   * instead of terminating it destructively. Opt-in via `close: true`: a body without it
   * takes the pre-existing scope/status path unchanged, so existing callers are unaffected.
   * Closing is handled before validateUpdateScope because a close needs neither a scope
   * nor a status, and requiring one would force callers to send a field they do not mean.
   */
  const body = (req.body ?? {}) as { close?: boolean; valid_to?: string; reason?: string };
  if (body.close === true) {
    const closed = await closeContextualRole({
      relationship_id: req.params.relationship_id,
      valid_to: body.valid_to,
      reason: body.reason,
    });
    if (!closed) {
      reply.code(404).send({ error: 'NotFound', code: 'RELATIONSHIP_NOT_FOUND', details: ['relationship not found'] });
      return;
    }
    reply.code(200).send({ data: { relationship: closed } });
    return;
  }

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

/** POST /api/relationships/roles — grant a contextual role (P16 EP-384). */
export async function grantRoleHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const details: string[] = [];
  if (!b.kind) details.push('kind is required');
  if (!b.persona_a) details.push('persona_a is required');
  if (!b.persona_b) details.push('persona_b is required');
  if (b.trust_state && !TRUST_STATES.includes(b.trust_state as TrustState)) {
    details.push(`trust_state must be one of ${TRUST_STATES.join(', ')}`);
  }
  if (details.length) { reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details }); return; }
  try {
    const role = await grantContextualRole(b as never);
    reply.code(201).send({ data: { role } });
  } catch (err) {
    const msg = (err as Error).message;
    // The evidence rule and the self-role rule are contract violations, not server faults.
    if (/requires at least one evidence_ref|cannot hold a contextual role to itself|trust_state must be/.test(msg)) {
      reply.code(400).send({ error: 'ValidationError', code: 'EVIDENCE_REQUIRED', details: [msg] });
      return;
    }
    if (/duplicate key|rel_live_role_idx/.test(msg)) {
      reply.code(409).send({ error: 'Conflict', code: 'ROLE_ALREADY_LIVE', details: ['a live role with this kind and label already exists for the pair'] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}

/** GET /api/relationships/roles — list roles, optionally as-of a past instant. */
export async function listRolesHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  if (!q.persona_a) { reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details: ['persona_a query param required'] }); return; }
  const roles = await listContextualRoles({
    persona_a: q.persona_a, persona_b: q.persona_b, kind: q.kind, role_label: q.role_label,
    trust_state: q.trust_state as TrustState | undefined,
    include_closed: q.include_closed === 'true',
    as_of: q.as_of, limit: q.limit ? Number(q.limit) : undefined,
  });
  reply.code(200).send({ data: { roles } });
}

/** POST /api/relationships/:relationship_id/attest — re-state trust, with evidence. */
export async function attestRoleHandler(req: FastifyRequest<{ Params: { relationship_id: string } }>, reply: FastifyReply): Promise<void> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!b.trust_state || !TRUST_STATES.includes(b.trust_state as TrustState)) {
    reply.code(400).send({
      error: 'ValidationError',
      code: 'VALIDATION_ERROR',
      details: [`trust_state must be one of ${TRUST_STATES.join(', ')}`],
    });
    return;
  }
  try {
    const role = await attestContextualRole({
      relationship_id: req.params.relationship_id,
      trust_state: b.trust_state as TrustState,
      evidence_refs: b.evidence_refs as string[] | undefined,
    });
    if (!role) { reply.code(404).send({ error: 'NotFound', code: 'RELATIONSHIP_NOT_FOUND' }); return; }
    reply.code(200).send({ data: { role } });
  } catch (err) {
    const msg = (err as Error).message;
    if (/requires at least one evidence_ref/.test(msg)) {
      reply.code(400).send({ error: 'ValidationError', code: 'EVIDENCE_REQUIRED', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
