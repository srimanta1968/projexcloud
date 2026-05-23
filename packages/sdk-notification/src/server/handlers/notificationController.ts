import { FastifyReply, FastifyRequest } from 'fastify';
import {
  TemplateNotFoundError,
  createTemplate,
  sendNotification,
} from '../../services/notificationService';
import { setQuietHours } from '../../services/quietHours';
import {
  validateCreateTemplate,
  validateSendNotification,
  validateSetQuietHours,
} from '../../validators/notificationValidator';

function authTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  const tid = req.auth?.tenant_id;
  if (!tid) {
    reply.code(403).send({ error: 'Forbidden', details: ['JWT missing tenant_id claim'] });
    return null;
  }
  return tid;
}

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof TemplateNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  const msg = (err as Error).message;
  if (msg.includes('duplicate key')) {
    reply.code(409).send({ error: 'Conflict', details: ['Template already exists for that (tenant, code, channel, version)'] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/notifications/send — dispatch with consent + quiet-hours + render. */
export async function sendHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateSendNotification(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const result = await sendNotification(v.value);
    const code = result.status === 'suppressed' ? 200 : 201;
    reply.code(code).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/notifications/templates — create platform-default or tenant-override template. */
export async function createTemplateHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  // Platform-default templates (no tenant_id) require service-actor auth — wired downstream.
  // Tenant-scoped templates: tenant_id MUST come from the caller's verified JWT.
  const incoming = (req.body as Record<string, unknown>) ?? {};
  const body = incoming.platform_default === true ? incoming : { ...incoming, tenant_id: tid };
  const v = validateCreateTemplate(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const template = await createTemplate(v.value);
    reply.code(201).send({ data: { template } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/notifications/quiet-hours — upsert per-persona quiet windows + dnd. */
export async function setQuietHoursHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  // Quiet-hours rows are persona-scoped; persona must belong to caller's tenant — caller is
  // expected to be acting on their own personas. (Cross-persona staff override is a separate
  // sdk-approval-gated flow not implemented here.)
  const incoming = (req.body as Record<string, unknown>) ?? {};
  const v = validateSetQuietHours({ ...incoming, _actor_tenant_id: tid });
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const record = await setQuietHours(v.value);
    reply.code(200).send({ data: { quiet_hours: record } });
  } catch (err) { fail(req, reply, err); }
}
