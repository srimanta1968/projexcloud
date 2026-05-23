import { FastifyReply, FastifyRequest } from 'fastify';
import { CatalogNotFoundError, generateInvoice } from '../../services/invoiceGenerator';
import { runRepriceDryRun } from '../../services/repriceDryRun';
import { readLiveMeter } from '../../services/liveMeter';
import { computeShowback } from '../../services/showback';
import {
  validateGenerateInvoice,
  validateLiveMeter,
  validateRepriceDryRun,
  validateShowback,
} from '../../validators/billingValidator';

/**
 * Pull tenant_id from the verified JWT, never the query / body. Billing
 * surfaces (live meter, showback, invoice gen) expose financial PII and
 * cannot trust caller-supplied tenant scoping. Resellers act on behalf of
 * child tenants via a separate impersonation flow (P6) — out of scope here.
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
  if (err instanceof CatalogNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/billing/invoices/generate */
export async function generateInvoiceHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateGenerateInvoice(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await generateInvoice(v.value);
    reply.code(201).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/billing/live — caller's own tenant only. */
export async function liveMeterHandler(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const v = validateLiveMeter({ ...req.query, tenant_id: tid });
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await readLiveMeter(v.value);
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/billing/reprice-dry-run */
export async function repriceDryRunHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateRepriceDryRun(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await runRepriceDryRun(v.value);
    reply.code(201).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/billing/showback?period_start=&period_end=&group_by=app_id,bu_id — caller's tenant only. */
export async function showbackHandler(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const v = validateShowback({ ...req.query, tenant_id: tid });
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await computeShowback(v.value);
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}
