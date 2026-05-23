import { FastifyReply, FastifyRequest } from 'fastify';
import {
  ChargeNotFoundError,
  DistributionOversubscribedError,
  InsufficientRefundableAmountError,
  PaymentMethodNotFoundError,
  TenantOwnershipError,
  attachPaymentMethod,
  charge,
  distribute,
  refund,
} from '../../services/paymentService';
import {
  validateAttachMethod,
  validateCharge,
  validateDistribute,
  validateRefund,
} from '../../validators/paymentValidator';

/**
 * Pull the authenticated caller's tenant from the JWT. The body's `tenant_id`
 * (if any) is overwritten — never trusted. Any handler reaching this without
 * `req.auth.tenant_id` set is mis-wired (requireAuth missing or JWT lacks the
 * P2 six-layer claim) and is a 403 rather than a 500.
 */
function authTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  const tid = req.auth?.tenant_id;
  if (!tid) {
    reply.code(403).send({ error: 'Forbidden', details: ['JWT missing tenant_id claim'] });
    return null;
  }
  return tid;
}

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof PaymentMethodNotFoundError || err instanceof ChargeNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof InsufficientRefundableAmountError) {
    reply.code(422).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof TenantOwnershipError) {
    reply.code(403).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof DistributionOversubscribedError) {
    reply.code(409).send({ error: err.code, details: [err.message] });
    return;
  }
  const msg = (err as Error).message;
  if (msg.includes('cannot be refunded') || msg.includes('cannot distribute') || msg.includes('is ')) {
    reply.code(409).send({ error: 'InvalidState', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/payments/methods - attach a tokenized payment method (FR-PAY-1/2). */
export async function attachMethodHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateAttachMethod(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const method = await attachPaymentMethod(v.value);
    reply.code(201).send({ data: { method } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/payments/charge - capture a charge via provider (FR-PAY-1). */
export async function chargeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateCharge(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const result = await charge(v.value);
    const code = result.status === 'captured' ? 201 : 200;
    reply.code(code).send({ data: { charge: result } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/payments/:charge_id/refund - issue refund (gated by sdk-approval for high-value). */
export async function refundHandler(
  req: FastifyRequest<{ Params: { charge_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const v = validateRefund(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const result = await refund(req.params.charge_id, v.value, tid);
    reply.code(201).send({ data: { refund: result } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/payments/:charge_id/distribute - append immutable distribution ledger entry. */
export async function distributeHandler(
  req: FastifyRequest<{ Params: { charge_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  // body's charge_id (if present) must match the path param
  const body = (req.body ?? {}) as Record<string, unknown>;
  body.charge_id = req.params.charge_id;
  const v = validateDistribute(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const records = await distribute(v.value, tid);
    reply.code(201).send({ data: { distributions: records } });
  } catch (err) { fail(req, reply, err); }
}
