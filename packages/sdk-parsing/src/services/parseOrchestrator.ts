import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { emit as emitLineage } from '@projexlight/sdk-lineage';
import type {
  ParseJobRef,
  ParseJobState,
  ParseRequestedMode,
  ParseStage,
  ParseStageStatus,
} from '@projexlight/contracts';
import {
  getClassifierBackend,
  getExtractorBackend,
  getOcrBackend,
  getValidatorBackend,
  type ExtractedFieldValue,
  type OcrOutput,
} from './backends';
import { resolveSchema } from './schemaResolver';

/**
 * 8-stage document parsing orchestrator (FR-PRS-1..6 / AC-1).
 *
 * Stages run in order:
 *   1. ingest        — load blob metadata, decode (here: a sync stub)
 *   2. ocr           — OcrBackend → text per page
 *   3. classify      — ClassifierBackend → document_kind + confidence
 *   4. schema-resolve — taxonomy lookup → field_specs
 *   5. extract       — ExtractorBackend → ExtractedFieldValue[]
 *   6. validate      — ValidatorBackend → per-field ok/fail
 *   7. review        — route below-threshold fields to needs-review queue
 *   8. route         — finalize job state + emit lineage edges per field
 *
 * Every stage writes a parsing.stage_result row. Every extracted_field
 * emits a lineage edge `extracted_from` source_blob → field (FR-PRS-6).
 * Audit + lineage cross-link via trace_id.
 */

const PARSING_AUDIT_POOL = process.env.PARSING_AUDIT_POOL || 'admin-default';
const NEEDS_REVIEW_THRESHOLD = parseFloat(process.env.PARSING_NEEDS_REVIEW_THRESHOLD ?? '0.7');

const ALL_STAGES: ParseStage[] = [
  'ingest',
  'ocr',
  'classify',
  'schema-resolve',
  'extract',
  'validate',
  'review',
  'route',
];

export interface ParseDocumentInput {
  tenant_id: string;
  source_blob_id: string;
  document_kind?: string;
  mode?: ParseRequestedMode;
  /** Pinned taxonomy version. When unset the resolver returns 'builtin-v1'. */
  taxonomy_version_id?: string;
  /** OTel trace_id for cross-SDK correlation. */
  trace_id: string;
}

interface JobRow {
  job_id: string;
  tenant_id: string;
  source_blob_id: string;
  document_kind: string;
  taxonomy_version_id: string;
  state: string;
  requested_mode: string;
  requested_at: Date;
  completed_at: Date | null;
  billed_units: string;
}

function rowToJob(r: JobRow): ParseJobRef {
  return {
    job_id: r.job_id,
    tenant_id: r.tenant_id,
    source_blob_id: r.source_blob_id,
    document_kind: r.document_kind,
    taxonomy_version_id: r.taxonomy_version_id,
    state: r.state as ParseJobState,
    requested_mode: r.requested_mode as ParseRequestedMode,
    requested_at: r.requested_at.toISOString(),
    completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    billed_units: Number(r.billed_units),
  };
}

async function createJob(input: ParseDocumentInput): Promise<JobRow> {
  const row = await dataService.one<JobRow>(
    `INSERT INTO parsing.job
       (job_id, tenant_id, source_blob_id, document_kind, taxonomy_version_id,
        state, requested_mode)
     VALUES ($1, $2::uuid, $3, $4, $5::uuid, 'queued', $6)
     RETURNING job_id, tenant_id::text, source_blob_id, document_kind,
               taxonomy_version_id::text, state, requested_mode,
               requested_at, completed_at, billed_units::text`,
    [
      randomUUID(),
      input.tenant_id,
      input.source_blob_id,
      input.document_kind ?? 'unknown',
      input.taxonomy_version_id ?? '00000000-0000-0000-0000-000000000001',
      input.mode ?? 'full-parse',
    ],
  );
  if (!row) throw new Error('[sdk-parsing] createJob insert failed');
  return row;
}

async function recordStage(
  job_id: string,
  stage: ParseStage,
  status: ParseStageStatus,
  latencyMs: number,
  payloadEnvelope?: Buffer,
): Promise<void> {
  await dataService.query(
    `INSERT INTO parsing.stage_result
       (result_id, job_id, stage, status, payload_envelope, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), job_id, stage, status, payloadEnvelope ?? null, latencyMs],
  );
}

async function updateJobState(job_id: string, state: ParseJobState): Promise<void> {
  await dataService.query(
    `UPDATE parsing.job
        SET state = $2,
            completed_at = CASE WHEN $2 IN ('completed','failed','needs-review') THEN now() ELSE completed_at END
      WHERE job_id = $1`,
    [job_id, state],
  );
}

interface PersistedField {
  field_id: string;
  field_name: string;
  confidence: number;
  needs_review: boolean;
  lineage_node_id: string;
}

async function persistField(input: {
  job: JobRow;
  field: ExtractedFieldValue;
  validatorOk: boolean;
  trace_id: string;
}): Promise<PersistedField> {
  const fieldId = randomUUID();
  const needsReview = !input.validatorOk || input.field.confidence < NEEDS_REVIEW_THRESHOLD;
  // Emit lineage edge first — node will exist when we write extracted_field
  // because lineage.emit creates the to-node if not present.
  const edge = await emitLineage({
    from: {
      ref_kind: 'media.blob',
      ref_id: input.job.source_blob_id,
      kind: 'blob',
      tenant_id: input.job.tenant_id,
    },
    to: {
      ref_kind: 'parsing.extracted_field',
      ref_id: fieldId,
      kind: 'field',
      tenant_id: input.job.tenant_id,
    },
    edge_kind: 'extracted_from',
    producer_sdk: 'sdk-parsing',
    trace_id: input.trace_id,
  });

  // Look up the to-node id so the FK in parsing.extracted_field resolves.
  const toNode = await dataService.one<{ node_id: string }>(
    `SELECT node_id FROM lineage.node WHERE ref_kind = $1 AND ref_id = $2`,
    ['parsing.extracted_field', fieldId],
  );
  const lineageNodeId = toNode?.node_id ?? edge.to_node_id;

  const valueEnvelope = input.field.value === null
    ? null
    : Buffer.from(String(input.field.value), 'utf8');

  await dataService.query(
    `INSERT INTO parsing.extracted_field
       (field_id, job_id, field_name, value_envelope, confidence,
        needs_review, provenance_span, lineage_node_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      fieldId,
      input.job.job_id,
      input.field.field_name,
      valueEnvelope,
      input.field.confidence,
      needsReview,
      JSON.stringify(input.field.provenance_span ?? {}),
      lineageNodeId,
    ],
  );

  if (needsReview) {
    await dataService.query(
      `INSERT INTO parsing.review_task
         (task_id, job_id, field_id, status)
       VALUES ($1, $2, $3, 'open')`,
      [randomUUID(), input.job.job_id, fieldId],
    );
  }

  return {
    field_id: fieldId,
    field_name: input.field.field_name,
    confidence: input.field.confidence,
    needs_review: needsReview,
    lineage_node_id: lineageNodeId,
  };
}

export interface ParseDocumentResult {
  job: ParseJobRef;
  fields: PersistedField[];
  stages: Array<{ stage: ParseStage; status: ParseStageStatus; latency_ms: number }>;
  needs_review: boolean;
}

/**
 * End-to-end 8-stage parse. Returns the job + every extracted field with
 * its lineage node id so callers can chain into downstream SDKs without
 * a second round-trip.
 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParseDocumentResult> {
  const job = await createJob(input);
  const stageLog: Array<{ stage: ParseStage; status: ParseStageStatus; latency_ms: number }> = [];
  const fields: PersistedField[] = [];
  await updateJobState(job.job_id, 'running');

  let ocrText = '';
  let ocrLanguage: string | undefined;
  let documentKind = input.document_kind ?? 'unknown';
  let fieldSpecs: Awaited<ReturnType<typeof resolveSchema>>['field_specs'] = [];
  let extractedFields: ExtractedFieldValue[] = [];
  let validatorResults: Awaited<ReturnType<ReturnType<typeof getValidatorBackend>['validate']>>['results'] = [];
  let hadFailure = false;

  for (const stage of ALL_STAGES) {
    const t0 = Date.now();
    let status: ParseStageStatus = 'succeeded';
    try {
      switch (stage) {
        case 'ingest':
          // v1 stub — the blob metadata land at job-create time. Real ingest
          // streams the blob into a working area, runs antivirus, etc.
          break;

        case 'ocr': {
          const out: OcrOutput = await getOcrBackend().ocr({
            source_blob_id: job.source_blob_id,
            tenant_id: job.tenant_id,
          });
          ocrText = out.pages.map((p) => p.text).join('\n\n');
          ocrLanguage = out.language;
          break;
        }

        case 'classify': {
          const out = await getClassifierBackend().classify({
            text: ocrText,
            hints: input.document_kind ? { document_kind: input.document_kind } : undefined,
          });
          documentKind = out.document_kind;
          // Persist updated document_kind so a re-extract task knows the type.
          await dataService.query(
            `UPDATE parsing.job SET document_kind = $2 WHERE job_id = $1`,
            [job.job_id, documentKind],
          );
          job.document_kind = documentKind;
          break;
        }

        case 'schema-resolve': {
          const resolved = await resolveSchema({
            document_kind: documentKind,
            taxonomy_version_id: input.taxonomy_version_id,
          });
          fieldSpecs = resolved.field_specs;
          break;
        }

        case 'extract': {
          if (fieldSpecs.length === 0) {
            status = 'skipped';
            break;
          }
          const out = await getExtractorBackend().extract({
            text: ocrText,
            field_specs: fieldSpecs,
            tenant_id: job.tenant_id,
          });
          extractedFields = out.fields;
          break;
        }

        case 'validate': {
          if (extractedFields.length === 0) {
            status = 'skipped';
            break;
          }
          const out = await getValidatorBackend().validate({
            fields: extractedFields,
            field_specs: fieldSpecs,
          });
          validatorResults = out.results;
          break;
        }

        case 'review': {
          if (extractedFields.length === 0) {
            status = 'skipped';
            break;
          }
          const okByName = new Map(validatorResults.map((r) => [r.field_name, r.ok] as const));
          for (const f of extractedFields) {
            const validatorOk = okByName.get(f.field_name) ?? true;
            const persisted = await persistField({ job, field: f, validatorOk, trace_id: input.trace_id });
            fields.push(persisted);
          }
          break;
        }

        case 'route': {
          // Mark job state based on the field outcomes.
          const anyNeedsReview = fields.some((f) => f.needs_review);
          await updateJobState(job.job_id, anyNeedsReview ? 'needs-review' : 'completed');
          break;
        }
      }
    } catch (err) {
      status = 'failed';
      hadFailure = true;
      console.error(`[sdk-parsing] stage ${stage} failed for job ${job.job_id}:`, (err as Error).message);
    }
    const latency = Date.now() - t0;
    stageLog.push({ stage, status, latency_ms: latency });
    await recordStage(job.job_id, stage, status, latency);
  }

  if (hadFailure) await updateJobState(job.job_id, 'failed');

  const finalJobRow = await dataService.one<JobRow>(
    `SELECT job_id, tenant_id::text, source_blob_id, document_kind,
            taxonomy_version_id::text, state, requested_mode,
            requested_at, completed_at, billed_units::text
       FROM parsing.job WHERE job_id = $1`,
    [job.job_id],
  );

  try {
    await appendAuditEntry({
      pool_index: PARSING_AUDIT_POOL,
      event_type: 'parsing.job.completed.v1',
      actor_kind: 'service',
      actor_id: 'sdk-parsing',
      tenant_id: job.tenant_id,
      subject_kind: 'parsing.job',
      subject_id: job.job_id,
      retention_class: 'regulated',
      payload: {
        job_id: job.job_id,
        document_kind: documentKind,
        field_count: fields.length,
        needs_review: fields.some((f) => f.needs_review),
        trace_id: input.trace_id,
      },
    });
  } catch (err) {
    console.warn('[sdk-parsing] job audit failed (non-fatal):', (err as Error).message);
  }

  return {
    job: finalJobRow ? rowToJob(finalJobRow) : rowToJob(job),
    fields,
    stages: stageLog,
    needs_review: fields.some((f) => f.needs_review),
  };
}

export async function getJob(job_id: string): Promise<ParseJobRef | null> {
  const row = await dataService.one<JobRow>(
    `SELECT job_id, tenant_id::text, source_blob_id, document_kind,
            taxonomy_version_id::text, state, requested_mode,
            requested_at, completed_at, billed_units::text
       FROM parsing.job WHERE job_id = $1`,
    [job_id],
  );
  return row ? rowToJob(row) : null;
}

export async function listJobs(tenant_id: string, limit = 100): Promise<ParseJobRef[]> {
  const rows = await dataService.rows<JobRow>(
    `SELECT job_id, tenant_id::text, source_blob_id, document_kind,
            taxonomy_version_id::text, state, requested_mode,
            requested_at, completed_at, billed_units::text
       FROM parsing.job
      WHERE tenant_id = $1::uuid
      ORDER BY requested_at DESC
      LIMIT $2`,
    [tenant_id, limit],
  );
  return rows.map(rowToJob);
}
