/**
 * @projexlight/sdk-ingest — P9.2 / Epic B (TK-3468 + TK-3469).
 *
 * The ETL batch front door: POST /api/ingest/:entity/batch imports external
 * records idempotently into ingest.record, with pluggable sdk-lineage provenance
 * + sdk-audit trail. Discoverable via the registry (endpoint kind='ingest').
 */

export { migrationsDir } from './db';
export {
  ingestBatch,
  setIngestHooks,
  INGEST_POOL,
  type IngestEnvelope,
  type IngestResult,
  type IngestMode,
  type IngestHooks,
} from './service';
export { registerIngestRoutes } from './server';
