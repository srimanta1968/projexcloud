import { FastifyReply, FastifyRequest } from 'fastify';
import {
  EndpointNotFoundError,
  UnregisteredEventTypeError,
  registerEndpoint,
  subscribe,
} from '../../services/endpointRegistry';
import { publishEvent } from '../../services/outboxWriter';
import {
  DeliveryNotInDlqError,
  DlqWindowExpiredError,
  listDlq,
  replayDelivery,
} from '../../services/dlqReplay';
import {
  validatePublish,
  validateRegisterEndpoint,
  validateSubscribe,
} from '../../validators/webhookValidator';

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof EndpointNotFoundError || err instanceof DeliveryNotInDlqError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof UnregisteredEventTypeError) {
    reply.code(400).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof DlqWindowExpiredError) {
    reply.code(409).send({ error: err.code, details: [err.message] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/webhooks/endpoints */
export async function registerEndpointHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateRegisterEndpoint(req.body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const endpoint = await registerEndpoint(v.value);
    reply.code(201).send({ data: { endpoint } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/webhooks/endpoints/:endpoint_id/subscribe */
export async function subscribeHandler(
  req: FastifyRequest<{ Params: { endpoint_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const body = (req.body && typeof req.body === 'object')
    ? { ...(req.body as Record<string, unknown>), endpoint_id: req.params.endpoint_id }
    : { endpoint_id: req.params.endpoint_id };
  const v = validateSubscribe(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const subscription = await subscribe(v.value);
    reply.code(201).send({ data: { subscription } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/webhooks/publish - test/manual fan-out. */
export async function publishHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validatePublish(req.body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const result = await publishEvent(v.value);
    reply.code(202).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/webhooks/deliveries?tenant_id=&dlq=true */
export async function listDeliveriesHandler(
  req: FastifyRequest<{ Querystring: { tenant_id?: string; limit?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tenant_id = req.query.tenant_id;
  if (!tenant_id) {
    reply.code(400).send({ error: 'ValidationError', details: ['tenant_id required'] });
    return;
  }
  try {
    const items = await listDlq({
      tenant_id,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    reply.code(200).send({ data: { deliveries: items } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/webhooks/deliveries/:delivery_id/replay */
export async function replayHandler(
  req: FastifyRequest<{ Params: { delivery_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const delivery = await replayDelivery(req.params.delivery_id);
    reply.code(200).send({ data: { delivery } });
  } catch (err) { fail(req, reply, err); }
}
