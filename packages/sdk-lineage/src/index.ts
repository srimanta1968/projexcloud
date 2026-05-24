/**
 * @projexlight/sdk-lineage — public surface.
 *
 * P6B · Closes Gate G8. Field-level provenance graph with in-pool
 * subgraph (sync ≤50ms) + cross-pool projection queue drained by
 * services/lineage-projector to Iceberg warehouse.cross_pool_lineage
 * (≤5min p99 per PRD §6).
 *
 * Edge kinds (FR-LIN-1): extracted_from · derived_from · merged_from
 * · scored_by · translated_by. Every P6B SDK that produces derived
 * data calls emit() exactly once per derivation step.
 */
export { migrationsDir } from './db';

export {
  emit,
  chain,
  crossPoolChain,
  claimProjectionBatch,
  markProjected,
  markFailed,
  rescheduleProjection,
} from './services/lineageService';

export type {
  CrossPoolChain,
  ProjectionClaim,
} from './services/lineageService';

// FR-LIN-5 / TK-3380 — backfill historical lineage from audit events.
export { runLineageBackfill, listBackfillEventTypes } from './services/backfillService';
export type { BackfillInput, BackfillResult } from './services/backfillService';
