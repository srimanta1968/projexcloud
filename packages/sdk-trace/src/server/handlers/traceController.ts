import { FastifyReply, FastifyRequest } from 'fastify';
import {
  getTraceTimeline,
  exportTrace,
  regressionAssert,
  type ExportFormat,
} from '../../services/traceService';

interface TraceIdParams { trace_id: string; }

/**
 * GET /api/trace/:trace_id — returns the full timeline (trace header +
 * spans in started_at order). Used by both ops debugging and the customer
 * self-serve audit-read API.
 */
export async function timelineHandler(
  req: FastifyRequest<{ Params: TraceIdParams }>,
  reply: FastifyReply,
): Promise<void> {
  if (!req.params.trace_id) {
    reply.code(400).send({ success: false, error: 'Missing path param: trace_id' });
    return;
  }
  try {
    const timeline = await getTraceTimeline(req.params.trace_id);
    reply.code(200).send({ success: true, data: timeline });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Lookup failed' });
  }
}

interface ExportBody {
  tenant_id: string;
  requestor_persona_id: string;
  trace_id: string;
  format: ExportFormat;
}

/**
 * POST /api/trace/exports — produce a signed PDF/JSON bundle. Returns the
 * persisted trace.export row including artifact_s3_key + signature so the
 * client can fetch via signed URL (signer is wired by the hosting service).
 */
export async function exportHandler(
  req: FastifyRequest<{ Body: ExportBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.tenant_id || !body?.requestor_persona_id || !body?.trace_id || !body?.format) {
    reply.code(400).send({
      success: false,
      error: 'Required: tenant_id, requestor_persona_id, trace_id, format (pdf|json)',
    });
    return;
  }
  if (body.format !== 'pdf' && body.format !== 'json') {
    reply.code(400).send({ success: false, error: 'format must be pdf or json' });
    return;
  }
  const actor = req.auth?.sub ?? 'system';
  try {
    const row = await exportTrace({ ...body, actor_id: actor });
    reply.code(201).send({
      success: true,
      data: {
        ...row,
        signature: row.signature.toString('hex'),
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Export failed' });
  }
}

interface AssertBody {
  trace_id: string;
  expected_layers: string[];
}

/**
 * POST /api/trace/regression-assert — assert a trace contains exactly the
 * expected layer set. Closes FR-TRC-8 / G-7 gap.
 */
export async function regressionAssertHandler(
  req: FastifyRequest<{ Body: AssertBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body;
  if (!body?.trace_id || !Array.isArray(body?.expected_layers)) {
    reply.code(400).send({
      success: false,
      error: 'Required: trace_id, expected_layers (string[])',
    });
    return;
  }
  try {
    const result = await regressionAssert(body);
    reply.code(200).send({ success: true, data: result });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Regression assert failed' });
  }
}
