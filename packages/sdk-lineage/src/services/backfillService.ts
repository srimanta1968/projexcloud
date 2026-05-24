import { dataService } from '@projexlight/db-runtime';
import { emit } from './lineageService';
import type { LineageEmitInput, LineageEdgeKind, LineageNodeKind } from '@projexlight/contracts';

/**
 * Lineage backfill from existing audit events (FR-LIN-5 / TK-3380).
 *
 * Walks the audit ledger (audit.entry) and synthesizes lineage.node +
 * lineage.edge rows for events that describe a derivation relationship.
 * Idempotent: emit() upserts on (ref_kind, ref_id) so re-running the
 * backfill never duplicates. Resumable: per-(pool_index, event_type)
 * checkpoints in lineage.backfill_checkpoint let a crashed worker pick
 * up where it left off.
 *
 * Mappers below own the per-event-type translation from audit payload
 * to LineageEmitInput. New event types are added by appending to the
 * `MAPPERS` table — no schema change required.
 */

export interface AuditEntryRow {
  entry_id: string;
  pool_index: string;
  seq: string | number;
  event_type: string;
  tenant_id: string | null;
  occurred_at: Date;
  payload: Record<string, unknown> | null;
  subject_kind: string | null;
  subject_id: string | null;
}

export interface BackfillInput {
  /** Limit scanning to this pool; omit to scan every pool present in audit.chain_head. */
  pool_index?: string;
  /** Limit to a single event_type (useful for ops triage); omit to process all known mappers. */
  event_type?: string;
  /** Max rows pulled per pool/event-type per call (controls memory). */
  batch_size?: number;
  /** When true, compute the mapping + count emit calls without writing anything. */
  dry_run?: boolean;
  /** When provided, only events with occurred_at >= from are scanned. */
  from?: Date;
  /** When provided, only events with occurred_at <= to are scanned. */
  to?: Date;
}

export interface BackfillResult {
  pools_scanned: string[];
  event_types_scanned: string[];
  rows_examined: number;
  rows_emitted: number;
  rows_skipped: number;
  errors: Array<{ entry_id: string; reason: string }>;
  dry_run: boolean;
}

interface CheckpointRow {
  last_seq: string;
  rows_emitted: string;
}

/**
 * Map an audit entry's payload + subject to a LineageEmitInput. Returning
 * null means the entry isn't a derivation worth recording.
 */
type Mapper = (entry: AuditEntryRow) => LineageEmitInput | null;

function strField(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

/** Per-event-type mappers. Add new ones by appending here. */
const MAPPERS: Record<string, Mapper> = {
  /**
   * parsing.field.extracted.v1 — extracted_field derived from source blob.
   * Payload contract per p6b-knowledge.ts ExtractedFieldRef:
   *   { field_id, job_id, source_blob_id, tenant_id, trace_id? }
   */
  'parsing.field.extracted.v1': (e) => {
    const p = e.payload ?? {};
    const fieldId = strField(p, 'field_id') ?? e.subject_id;
    const blobId = strField(p, 'source_blob_id');
    const tenantId = e.tenant_id ?? strField(p, 'tenant_id');
    if (!fieldId || !blobId || !tenantId) return null;
    return {
      from: { ref_kind: 'media.blob', ref_id: blobId, kind: 'blob', tenant_id: tenantId },
      to: { ref_kind: 'parsing.extracted_field', ref_id: fieldId, kind: 'field', tenant_id: tenantId },
      edge_kind: 'extracted_from' satisfies LineageEdgeKind,
      producer_sdk: 'sdk-parsing',
      producer_event_id: e.entry_id,
      trace_id: strField(p, 'trace_id') ?? e.entry_id,
    };
  },

  /**
   * recommendation.suggestion.generated.v1 — suggestion scored_by model.
   * Payload: { suggestion_id, model_id, subject_persona_id, trace_id }
   */
  'recommendation.suggestion.generated.v1': (e) => {
    const p = e.payload ?? {};
    const suggestionId = strField(p, 'suggestion_id') ?? e.subject_id;
    const modelId = strField(p, 'model_id');
    const tenantId = e.tenant_id ?? strField(p, 'tenant_id');
    if (!suggestionId || !modelId || !tenantId) return null;
    return {
      from: { ref_kind: 'recommendation.model', ref_id: modelId, kind: 'model', tenant_id: tenantId },
      to: { ref_kind: 'recommendation.suggestion', ref_id: suggestionId, kind: 'recommendation', tenant_id: tenantId },
      edge_kind: 'scored_by' satisfies LineageEdgeKind,
      producer_sdk: 'sdk-recommendation',
      producer_event_id: e.entry_id,
      trace_id: strField(p, 'trace_id') ?? e.entry_id,
    };
  },

  /**
   * semantic.intent.planned.v1 — intent_plan derived from intent.
   * Payload: { plan_id, intent_id, subject_id, trace_id }
   */
  'semantic.intent.planned.v1': (e) => {
    const p = e.payload ?? {};
    const planId = strField(p, 'plan_id');
    const intentId = strField(p, 'intent_id');
    const tenantId = e.tenant_id ?? strField(p, 'tenant_id');
    if (!planId || !intentId || !tenantId) return null;
    return {
      from: { ref_kind: 'semantic.intent', ref_id: intentId, kind: 'record', tenant_id: tenantId },
      to: { ref_kind: 'semantic.intent_plan', ref_id: planId, kind: 'agent-output', tenant_id: tenantId },
      edge_kind: 'derived_from' satisfies LineageEdgeKind,
      producer_sdk: 'sdk-semantic',
      producer_event_id: e.entry_id,
      trace_id: strField(p, 'trace_id') ?? e.entry_id,
    };
  },

  /**
   * ai-gateway.complete.v1 — agent run produced an output derived from the
   * model invocation. We record the agent-output node here so the chain
   * from prompt → completion → downstream action is traceable.
   * Payload: { completion_id, run_id, model, trace_id }
   */
  'ai-gateway.complete.v1': (e) => {
    const p = e.payload ?? {};
    const completionId = strField(p, 'completion_id');
    const runId = strField(p, 'run_id');
    const tenantId = e.tenant_id ?? strField(p, 'tenant_id');
    if (!completionId || !runId || !tenantId) return null;
    return {
      from: { ref_kind: 'agents.agent_run', ref_id: runId, kind: 'record', tenant_id: tenantId },
      to: { ref_kind: 'ai_gateway.completion', ref_id: completionId, kind: 'agent-output', tenant_id: tenantId },
      edge_kind: 'derived_from' satisfies LineageEdgeKind,
      producer_sdk: 'sdk-ai-gateway',
      producer_event_id: e.entry_id,
      trace_id: strField(p, 'trace_id') ?? e.entry_id,
    };
  },
};

export function listBackfillEventTypes(): string[] {
  return Object.keys(MAPPERS);
}

async function loadCheckpoint(pool_index: string, event_type: string): Promise<{ last_seq: number; rows_emitted: number }> {
  const row = await dataService.one<CheckpointRow>(
    `SELECT last_seq::text, rows_emitted::text
       FROM lineage.backfill_checkpoint
      WHERE pool_index = $1 AND event_type = $2`,
    [pool_index, event_type],
  );
  return {
    last_seq: row ? Number(row.last_seq) : 0,
    rows_emitted: row ? Number(row.rows_emitted) : 0,
  };
}

async function saveCheckpoint(
  pool_index: string,
  event_type: string,
  last_seq: number,
  rows_emitted: number,
  last_error: string | null,
): Promise<void> {
  await dataService.query(
    `INSERT INTO lineage.backfill_checkpoint
       (pool_index, event_type, last_seq, rows_emitted, last_run_at, last_error)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (pool_index, event_type) DO UPDATE
       SET last_seq = EXCLUDED.last_seq,
           rows_emitted = EXCLUDED.rows_emitted,
           last_run_at = now(),
           last_error = EXCLUDED.last_error`,
    [pool_index, event_type, last_seq, rows_emitted, last_error],
  );
}

async function listPools(filterPool?: string): Promise<string[]> {
  if (filterPool) return [filterPool];
  const rows = await dataService.rows<{ pool_index: string }>(
    `SELECT DISTINCT pool_index FROM audit.chain_head ORDER BY pool_index`,
  );
  return rows.map((r) => r.pool_index);
}

/**
 * Walk the audit log for one (pool_index, event_type) and emit lineage
 * edges. Stops after batch_size entries OR when the cursor catches up.
 * Returns rows examined / emitted / skipped for the caller's aggregate.
 */
async function processOne(
  pool_index: string,
  event_type: string,
  mapper: Mapper,
  cursor_seq: number,
  batch_size: number,
  filters: { from?: Date; to?: Date },
  dry_run: boolean,
  result: BackfillResult,
): Promise<number> {
  const rows = await dataService.rows<AuditEntryRow>(
    `SELECT entry_id, pool_index, seq::text, event_type, tenant_id::text,
            occurred_at, payload, subject_kind, subject_id
       FROM audit.entry
      WHERE pool_index = $1
        AND event_type = $2
        AND seq > $3
        AND ($4::timestamptz IS NULL OR occurred_at >= $4)
        AND ($5::timestamptz IS NULL OR occurred_at <= $5)
      ORDER BY seq
      LIMIT $6`,
    [pool_index, event_type, cursor_seq, filters.from ?? null, filters.to ?? null, batch_size],
  );

  let last = cursor_seq;
  for (const row of rows) {
    result.rows_examined += 1;
    const seqNum = Number(row.seq);
    last = seqNum;
    const input = mapper(row);
    if (!input) {
      result.rows_skipped += 1;
      continue;
    }
    if (dry_run) {
      result.rows_emitted += 1;
      continue;
    }
    try {
      await emit(input);
      result.rows_emitted += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ entry_id: row.entry_id, reason: msg });
      // continue — one bad row should not stop the batch
    }
  }
  return last;
}

/**
 * Run a backfill pass. Safe to call repeatedly — already-processed rows
 * are skipped via the checkpoint. dry_run mode reports counts without
 * writing anything to lineage tables or the checkpoint.
 */
export async function runLineageBackfill(input: BackfillInput = {}): Promise<BackfillResult> {
  const batch_size = input.batch_size ?? 500;
  const dry_run = input.dry_run ?? false;
  const result: BackfillResult = {
    pools_scanned: [],
    event_types_scanned: [],
    rows_examined: 0,
    rows_emitted: 0,
    rows_skipped: 0,
    errors: [],
    dry_run,
  };

  const pools = await listPools(input.pool_index);
  const eventTypes = input.event_type
    ? [input.event_type]
    : Object.keys(MAPPERS);

  for (const pool of pools) {
    result.pools_scanned.push(pool);
    for (const eventType of eventTypes) {
      const mapper = MAPPERS[eventType];
      if (!mapper) continue;
      if (!result.event_types_scanned.includes(eventType)) result.event_types_scanned.push(eventType);

      const cp = await loadCheckpoint(pool, eventType);
      const lastSeq = await processOne(
        pool,
        eventType,
        mapper,
        cp.last_seq,
        batch_size,
        { from: input.from, to: input.to },
        dry_run,
        result,
      );

      if (!dry_run && lastSeq > cp.last_seq) {
        const emittedDelta = result.rows_emitted; // approximate; per-pool granularity tracked
        await saveCheckpoint(
          pool,
          eventType,
          lastSeq,
          cp.rows_emitted + emittedDelta,
          result.errors.length > 0 ? result.errors[result.errors.length - 1].reason : null,
        );
      }
    }
  }

  return result;
}
