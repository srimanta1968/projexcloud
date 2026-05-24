import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Trace timeline + export service (G12).
 *
 * Reads from the Postgres mirror of trace.trace + trace.span. The OLAP
 * production path uses the ClickHouse mirror (bootstrapped by TK-3320)
 * for hot queries at scale; the Postgres copy backstops dev/test and
 * the FR-TRC-8 regression-assert endpoint.
 *
 * Export persists a signed bundle to S3 (via signed URL) and records
 * trace.export with the artifact key + signature. Customer self-serve
 * is wired by sdk-billing's /billing/verify endpoint (TK-3287 ships
 * the trace.export persistence; the /billing/verify GET re-uses the
 * artifact_s3_key column directly).
 */

const TRACE_AUDIT_POOL = process.env.TRACE_AUDIT_POOL || 'admin-default';

export interface TraceHeader {
  trace_id: string;
  tenant_id: string | null;
  persona_id: string | null;
  started_at: Date;
  completed_at: Date | null;
  root_span_id: string | null;
  total_latency_ms: number | null;
  error_count: number;
  budget_violations: Record<string, { budget_ms: number; actual_ms: number }>;
}

export interface TraceSpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  layer: string;
  operation: string;
  started_at: Date;
  ended_at: Date;
  latency_ms: number;
  status: 'ok' | 'error' | 'cancelled';
  attributes: Record<string, unknown>;
  audit_entry_id: string | null;
  usage_event_id: string | null;
  agent_run_id: string | null;
}

export interface TraceTimeline {
  trace: TraceHeader;
  spans: TraceSpanRow[];
}

/**
 * Returns the trace header + every span in started_at order. Empty
 * spans array is valid (trace recorded but no spans yet). Throws when
 * the trace_id has no matching row — caller surfaces 404.
 */
export async function getTraceTimeline(trace_id: string): Promise<TraceTimeline> {
  const trace = await dataService.one<TraceHeader>(
    `SELECT trace_id, tenant_id::text, persona_id::text, started_at, completed_at,
            root_span_id, total_latency_ms, error_count, budget_violations
       FROM trace.trace WHERE trace_id = $1`,
    [trace_id],
  );
  if (!trace) throw new Error(`[trace] trace_id ${trace_id} not found`);

  const r = await dataService.query<TraceSpanRow>(
    `SELECT span_id, trace_id, parent_span_id, layer, operation,
            started_at, ended_at, latency_ms, status, attributes,
            audit_entry_id::text, usage_event_id::text, agent_run_id::text
       FROM trace.span
      WHERE trace_id = $1
      ORDER BY started_at ASC, span_id ASC`,
    [trace_id],
  );
  return { trace, spans: r.rows };
}

export type ExportFormat = 'pdf' | 'json';

export interface TraceExportInput {
  tenant_id: string;
  requestor_persona_id: string;
  trace_id: string;
  format: ExportFormat;
  actor_id: string;
}

export interface TraceExport {
  export_id: string;
  tenant_id: string;
  requestor_persona_id: string;
  trace_id: string;
  format: ExportFormat;
  artifact_s3_key: string;
  signature: Buffer;
  requested_at: Date;
  ready_at: Date | null;
}

const EXPORT_BUCKET = process.env.TRACE_EXPORT_BUCKET ?? 'projexcloud-trace-exports';
const EXPORT_SIGNING_SECRET = process.env.TRACE_EXPORT_SIGNING_SECRET ?? 'dev-signing-secret';

/**
 * Generate a deterministic S3 key + signed signature for the export
 * artifact. Production uploads the rendered bundle to S3 via a signer
 * adapter (registered at boot like sdk-media's S3 signer); the row is
 * persisted with ready_at populated once the upload completes.
 *
 * For prototype scope this synchronously synthesises the key + signature
 * and marks ready_at immediately. A real bundle renderer can hook in
 * later without changing the row shape.
 */
function signArtifactKey(s3Key: string): Buffer {
  return crypto.createHmac('sha256', EXPORT_SIGNING_SECRET).update(s3Key, 'utf8').digest();
}

export async function exportTrace(input: TraceExportInput): Promise<TraceExport> {
  // Refuse if the trace doesn't exist — otherwise we'd persist a dangling
  // export row that the customer can't actually fetch.
  await getTraceTimeline(input.trace_id);

  const exportId = crypto.randomUUID();
  const s3Key = `${EXPORT_BUCKET}/${input.tenant_id}/${input.trace_id}/${exportId}.${input.format}`;
  const signature = signArtifactKey(s3Key);

  const row = await dataService.one<TraceExport>(
    `INSERT INTO trace.export
       (export_id, tenant_id, requestor_persona_id, trace_id, format,
        artifact_s3_key, signature, ready_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, now())
     RETURNING export_id, tenant_id::text, requestor_persona_id::text,
               trace_id, format, artifact_s3_key, signature, requested_at, ready_at`,
    [
      exportId,
      input.tenant_id,
      input.requestor_persona_id,
      input.trace_id,
      input.format,
      s3Key,
      signature,
    ],
  );
  if (!row) throw new Error('[trace] failed to insert trace.export row');

  try {
    await appendAuditEntry({
      pool_index: TRACE_AUDIT_POOL,
      event_type: 'trace.export.requested.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: input.tenant_id,
      subject_kind: 'trace.export',
      subject_id: exportId,
      retention_class: 'operational',
      payload: { trace_id: input.trace_id, format: input.format, artifact_s3_key: s3Key },
    });
    await appendAuditEntry({
      pool_index: TRACE_AUDIT_POOL,
      event_type: 'trace.export.ready.v1',
      actor_kind: 'service',
      actor_id: 'sdk-trace.exporter',
      tenant_id: input.tenant_id,
      subject_kind: 'trace.export',
      subject_id: exportId,
      retention_class: 'operational',
      payload: { trace_id: input.trace_id, artifact_s3_key: s3Key },
    });
  } catch (auditErr) {
    console.error(
      '[trace] audit emit failed for export',
      exportId,
      (auditErr as Error).message,
    );
  }

  return row;
}

/**
 * Returns true iff the trace has spans for every layer in `expected`.
 * Used by FR-TRC-8 regression-assert (TK-3309) to lock the expected
 * layer composition for known request shapes.
 */
export interface RegressionAssertInput {
  trace_id: string;
  expected_layers: string[];
}

export interface RegressionAssertResult {
  pass: boolean;
  trace_id: string;
  matched_layers: string[];
  missing_layers: string[];
  extra_layers: string[];
}

export async function regressionAssert(
  input: RegressionAssertInput,
): Promise<RegressionAssertResult> {
  const r = await dataService.query<{ layer: string }>(
    `SELECT DISTINCT layer FROM trace.span WHERE trace_id = $1`,
    [input.trace_id],
  );
  const actual = new Set(r.rows.map((row) => row.layer));
  const expected = new Set(input.expected_layers);
  const matched: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const layer of expected) {
    if (actual.has(layer)) matched.push(layer);
    else missing.push(layer);
  }
  for (const layer of actual) {
    if (!expected.has(layer)) extra.push(layer);
  }
  return {
    pass: missing.length === 0,
    trace_id: input.trace_id,
    matched_layers: matched,
    missing_layers: missing,
    extra_layers: extra,
  };
}
