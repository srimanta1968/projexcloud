import { FastifyReply, FastifyRequest } from 'fastify';
import {
  StepHandlerNotFoundError,
  WorkflowDefinitionMissingHandlersError,
  WorkflowDefinitionNotFoundError,
  getRun,
  registerWorkflow,
  signal,
  startRun,
} from '../../services/workflowService';
import {
  validateRegisterDefinition,
  validateSignal,
  validateStartRun,
} from '../../validators/workflowValidator';

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof WorkflowDefinitionMissingHandlersError) {
    reply.code(400).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof WorkflowDefinitionNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof StepHandlerNotFoundError) {
    reply.code(400).send({ error: err.code, details: [err.message] });
    return;
  }
  const msg = (err as Error).message;
  // "not in running" matches both "...not in running state" and the signal
  // path's "...not in running/paused state" — the latter previously fell
  // through to a misleading 500.
  if (msg.includes('not found') || msg.includes('not in running')) {
    reply.code(409).send({ error: 'InvalidState', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/workflows/definitions - register or upsert a workflow definition. */
export async function registerDefHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateRegisterDefinition(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const def = await registerWorkflow(v.value);
    reply.code(201).send({ data: { definition: def } });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/workflows/start - start a run of a registered workflow. */
export async function startRunHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const v = validateStartRun(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  // FR-WFL-1: envelope context inherits from the auth JWT if not explicitly
  // passed. This is the standard pattern — callers can override per-run.
  const envelope = v.value.envelope ?? {
    tenant_id: req.auth?.tenant_id ?? undefined,
    persona_id: req.auth?.sub ?? undefined,
    actor: { kind: 'human', id: req.auth?.sub ?? undefined },
  };
  try {
    const result = await startRun({ ...v.value, envelope });
    reply.code(201).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/workflows/:run_id/signal - signal an in-progress run. */
export async function signalHandler(
  req: FastifyRequest<{ Params: { run_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const v = validateSignal(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    await signal(req.params.run_id, v.value.signal_name, v.value.payload ?? {});
    reply.code(200).send({ data: { signaled: true } });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/workflows/:run_id - query run state + steps + compensations. */
export async function queryRunHandler(
  req: FastifyRequest<{ Params: { run_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const result = await getRun(req.params.run_id);
    if (!result) {
      reply.code(404).send({ error: 'NotFound', details: [`Run ${req.params.run_id} not found`] });
      return;
    }
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}
