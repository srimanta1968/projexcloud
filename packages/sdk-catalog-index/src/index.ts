/**
 * @projexlight/sdk-catalog-index — P9.2 / Epic A.
 *
 * The global SDK catalog RAG store: auto-migrated catalog.* tables (Postgres +
 * pgvector, global-catalog pool), an incremental sync job that embeds manifest
 * cards with the local bge-small model, and the vector/relational read surface
 * the build planner + registry MCP use to retrieve SDKs, endpoints, and ingest
 * targets.
 *
 * Wiring (api-gateway boot):
 *   import { migrationsDir, syncCatalog } from '@projexlight/sdk-catalog-index';
 *   await runMigrations([ ..., { sdk: 'sdk-catalog-index', dir: migrationsDir } ]);
 *   await syncCatalog({ repoRoot });   // incremental; embeds only changed SDKs
 */

export { migrationsDir } from './db';
export { syncCatalog, type SyncOptions, type SyncSummary } from './sync';
export {
  embed,
  embedAll,
  getEmbedder,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  MODEL_TAG,
} from './embedder';
export {
  searchCatalog,
  getEndpoint,
  getIngestTargets,
  getSyncVersion,
  bumpSyncVersion,
  loadCatalogSnapshot,
  reloadIfChanged,
  CATALOG_POOL,
  type SearchHit,
  type SdkRow,
  type EndpointRow,
  type EmbeddingUpsert,
  type CatalogSnapshot,
  type CatalogSnapshotRow,
} from './store';
