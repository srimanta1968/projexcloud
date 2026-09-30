import { FastifyReply, FastifyRequest } from 'fastify';
import {
  NotYourStepError,
  RouteNotFoundError,
  StepAlreadyDecidedError,
  StepNotFoundError,
  createRoute,
  decide,
  getRequest,
  submitRequest,
} from '../../services/approvalService';
import {
  validateCreateRoute,
  validateDecide,
  validateSubmitRequest,
} from '../../validators/approvalValidator';

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof RouteNotFoundError || err instanceof StepNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof NotYourStepError) {
    reply.code(403).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof StepAlreadyDecidedError) {
    reply.code(409).send({ error: err.code, details: [err.message] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/approvals/routes */
export async function createRouteHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateCreateRoute(req.body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const route = await createRoute(v.value);
    reply.code(201).send({ data: { route } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/approvals/requests */
export async function submitRequestHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateSubmitRequest(req.body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await submitRequest(v.value);
    reply.code(201).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** The personas the authenticated caller may act as (primary, any other, and its subject). */
function callerPersonas(req: FastifyRequest): Set<string> {
  const auth = (req as FastifyRequest & { auth?: { sub?: string; primary_persona_id?: string | null; all_persona_ids?: string[] } }).auth;
  const ids = [auth?.primary_persona_id, auth?.sub, ...(auth?.all_persona_ids ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return new Set(ids);
}

/**
 * POST /api/approvals/steps/:step_id/decide
 *
 * The acting persona is the CALLER's: omitted, it defaults to the caller's primary persona;
 * given, it must be one of the caller's own personas (403 otherwise). It used to be taken
 * from the body as-is, so anyone could decide a step by naming its approver — which made
 * every approval gate (voice agent publish included) self-approvable.
 */
export async function decideHandler(
  req: FastifyRequest<{ Params: { step_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const mine = callerPersonas(req);
  const body = { ...((req.body ?? {}) as Record<string, unknown>) };
  const primary = (req as FastifyRequest & { auth?: { primary_persona_id?: string | null; sub?: string } }).auth;
  if (body.acting_persona_id === undefined || body.acting_persona_id === null || body.acting_persona_id === '') {
    body.acting_persona_id = primary?.primary_persona_id ?? primary?.sub;
  }
  if (typeof body.acting_persona_id === 'string' && mine.size > 0 && !mine.has(body.acting_persona_id)) {
    reply.code(403).send({ error: 'NotYourPersona', details: ['acting_persona_id is not a persona of the authenticated caller'] });
    return;
  }
  const v = validateDecide(body, req.params.step_id);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await decide(v.value);
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/approvals/requests/:request_id */
export async function getRequestHandler(
  req: FastifyRequest<{ Params: { request_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const result = await getRequest(req.params.request_id);
    if (!result) {
      reply.code(404).send({ error: 'NotFound', details: [`Request ${req.params.request_id} not found`] });
      return;
    }
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}
