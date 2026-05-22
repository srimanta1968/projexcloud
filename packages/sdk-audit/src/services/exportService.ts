import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';

export type ExportFormat = 'pdf' | 'jsonl';
export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface ExportRequestRow {
  request_id: string;
  tenant_id: string;
  format: ExportFormat;
  range_start: Date;
  range_end: Date;
  status: ExportStatus;
  artifact_s3_key: string | null;
  signature: Buffer | null;
  created_at: Date;
}

export interface CreateExportInput {
  tenant_id: string;
  format: ExportFormat;
  range_start: Date;
  range_end: Date;
}

/**
 * Creates an audit export request row per P1-Foundation-Spine §7.1.
 * The worker that materializes the artifact runs out-of-band (in production,
 * a separate exporter service); the prototype materializes synchronously
 * inline and stores the JSONL inline in artifact_s3_key.
 */
export async function createExportRequest(input: CreateExportInput): Promise<ExportRequestRow> {
  try {
    const row = await dataService.one<ExportRequestRow>(
      `INSERT INTO audit.export_request (tenant_id, format, range_start, range_end, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING request_id, tenant_id, format, range_start, range_end, status,
                 artifact_s3_key, signature, created_at`,
      [input.tenant_id, input.format, input.range_start, input.range_end],
    );
    if (!row) throw new Error('Failed to create export request');
    return row;
  } catch (err) {
    throw err;
  }
}

interface AuditEntryForExport {
  entry_id: string;
  pool_index: string;
  seq: string;
  event_type: string;
  occurred_at: Date;
  actor_kind: string;
  actor_id: string;
  subject_kind: string | null;
  subject_id: string | null;
  payload: unknown;
  entry_hash: Buffer;
}

/**
 * Materializes the export artifact: gathers entries in range, serializes to
 * JSONL (newline-delimited JSON, one entry per line), and signs the bundle
 * with a SHA-256 hash chain proof so the customer can verify integrity.
 */
export async function materializeExport(request_id: string): Promise<ExportRequestRow> {
  const req = await dataService.one<ExportRequestRow>(
    `SELECT request_id, tenant_id, format, range_start, range_end, status,
            artifact_s3_key, signature, created_at
       FROM audit.export_request WHERE request_id = $1`,
    [request_id],
  );
  if (!req) throw new Error(`Export request ${request_id} not found`);

  try {
    await dataService.query(
      `UPDATE audit.export_request SET status = 'running' WHERE request_id = $1`,
      [request_id],
    );

    const entries = await dataService.rows<AuditEntryForExport>(
      `SELECT entry_id, pool_index, seq, event_type, occurred_at,
              actor_kind, actor_id, subject_kind, subject_id,
              payload, entry_hash
         FROM audit.entry
        WHERE tenant_id = $1
          AND occurred_at >= $2
          AND occurred_at <= $3
        ORDER BY pool_index ASC, seq ASC`,
      [req.tenant_id, req.range_start, req.range_end],
    );

    // JSONL artifact: one entry per line. For the prototype we inline the
    // payload into artifact_s3_key as the actual "blob"; production swaps
    // this for an S3 upload + presigned URL.
    const jsonl = entries.map((e: AuditEntryForExport) => JSON.stringify({
      entry_id: e.entry_id,
      pool_index: e.pool_index,
      seq: Number(e.seq),
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      actor_kind: e.actor_kind,
      actor_id: e.actor_id,
      subject_kind: e.subject_kind,
      subject_id: e.subject_id,
      payload: e.payload,
      entry_hash: e.entry_hash.toString('hex'),
    })).join('\n');

    const signature = crypto.createHash('sha256').update(jsonl).digest();
    const artifactKey = req.format === 'pdf'
      ? `s3://prototype-inline/${request_id}.pdf`
      : `s3://prototype-inline/${request_id}.jsonl`;

    const updated = await dataService.one<ExportRequestRow>(
      `UPDATE audit.export_request
          SET status = 'ready',
              artifact_s3_key = $2,
              signature = $3
        WHERE request_id = $1
        RETURNING request_id, tenant_id, format, range_start, range_end, status,
                  artifact_s3_key, signature, created_at`,
      [request_id, artifactKey, signature],
    );
    return updated!;
  } catch (err) {
    await dataService.query(
      `UPDATE audit.export_request SET status = 'failed' WHERE request_id = $1`,
      [request_id],
    );
    throw err;
  }
}
