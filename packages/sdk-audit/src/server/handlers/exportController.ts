import { FastifyReply, FastifyRequest } from 'fastify';
import { createExportRequest, materializeExport, type ExportFormat } from '../../services/exportService';

interface ExportBody {
  tenant_id?: string;
  format?: ExportFormat;
  range_start?: string;
  range_end?: string;
  inline?: boolean;
}

/**
 * POST /api/audit/export — customer-facing self-audit export per FR-AUD-4.
 * Tenants request a signed PDF or JSONL of their own audit chain over a date
 * range. The request is queued; pass `inline=true` to materialize synchronously
 * (prototype convenience).
 */
export async function exportHandler(req: FastifyRequest<{ Body: ExportBody }>, reply: FastifyReply): Promise<void> {
  const body = req.body ?? {};
  const tenant_id = typeof body.tenant_id === 'string' ? body.tenant_id : '';
  const format = (body.format ?? 'jsonl') as ExportFormat;
  const range_start = body.range_start ? new Date(body.range_start) : null;
  const range_end = body.range_end ? new Date(body.range_end) : null;

  const errors: string[] = [];
  if (!tenant_id) errors.push('tenant_id is required');
  if (format !== 'pdf' && format !== 'jsonl') errors.push('format must be pdf or jsonl');
  if (!range_start || isNaN(range_start.getTime())) errors.push('range_start (ISO 8601) required');
  if (!range_end || isNaN(range_end.getTime())) errors.push('range_end (ISO 8601) required');
  if (range_start && range_end && range_start > range_end) errors.push('range_start must be <= range_end');

  if (errors.length > 0) {
    reply.code(400).send({ error: 'ValidationError', details: errors });
    return;
  }

  try {
    const request = await createExportRequest({
      tenant_id,
      format,
      range_start: range_start!,
      range_end: range_end!,
    });

    if (body.inline === true) {
      const materialized = await materializeExport(request.request_id);
      reply.code(201).send({
        data: {
          request_id: materialized.request_id,
          status: materialized.status,
          artifact_s3_key: materialized.artifact_s3_key,
          signature_hex: materialized.signature?.toString('hex') ?? null,
        },
      });
      return;
    }

    reply.code(202).send({
      data: {
        request_id: request.request_id,
        status: request.status,
      },
    });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
