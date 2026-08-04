import { FastifyReply, FastifyRequest } from 'fastify';
import { appendAuditEntry } from '../../services/auditService';
import { validateAppendInput } from '../../validators/auditValidator';

/**
 * POST /api/audit/append — appends a hash-chained immutable entry to the
 * caller-specified pool's audit chain. Requires authentication (JWT subject
 * becomes `actor_id` unless overridden in the payload).
 */
export async function appendHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const validation = validateAppendInput(req.body);
  if (!validation.ok) {
    reply.code(400).send({ error: 'ValidationError', details: validation.errors });
    return;
  }

  try {
    const entry = await appendAuditEntry({
      pool_index: validation.value.pool_index,
      event_type: validation.value.event_type,
      payload: validation.value.payload,
      actor_kind: validation.value.actor_kind ?? 'human',
      actor_id: req.auth?.sub ?? 'unknown',
      // Falls back to the caller's own tenant claim (TK-4144). Without this a
      // body that omits tenant_id resolves against the platform baseline only,
      // so an app's own registered event type would be rejected even though it
      // registered it correctly.
      tenant_id: validation.value.tenant_id ?? req.auth?.tenant_id ?? null,
      org_id: validation.value.org_id ?? null,
      app_id: validation.value.app_id ?? null,
      bu_id: validation.value.bu_id ?? null,
      subject_kind: validation.value.subject_kind ?? null,
      subject_id: validation.value.subject_id ?? null,
      retention_class: validation.value.retention_class,
    });
    reply.code(201).send({
      data: {
        entry_id: entry.entry_id,
        pool_index: entry.pool_index,
        seq: Number(entry.seq),
        entry_hash: entry.entry_hash.toString('hex'),
        prev_hash: entry.prev_hash ? entry.prev_hash.toString('hex') : null,
        recorded_at: entry.recorded_at,
        retention_class: entry.retention_class,
        expires_at: entry.expires_at,
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('Unregistered event_type')) {
      reply.code(400).send({ error: 'UnregisteredEventType', details: [msg] });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
