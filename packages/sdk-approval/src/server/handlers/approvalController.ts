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

/** POST /api/approvals/steps/:step_id/decide */
export async function decideHandler(
  req: FastifyRequest<{ Params: { step_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateDecide(req.body, req.params.step_id);
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
