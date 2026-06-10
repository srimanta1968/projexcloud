import { dataService } from '@projexlight/db-runtime';

/**
 * pgvector access layer for the global SDK catalog (Epic A).
 *
 * All access targets the `global-catalog` pool. Writes go through the sync job;
 * reads (searchCatalog / getEndpoint / getIngestTargets) back the build planner
 * and the registry MCP. Vectors are passed as pgvector text literals cast with
 * `$n::vector` — pg has no native array→vector binding.
 */

export const CATALOG_POOL = 'global-catalog';

export interface SdkRow {
  name: string;
  version: string | null;
  summary: string;
  tags: string[];
  tier: 'foundation' | 'domain';
  pool_placement: string | null;
  content_hash: string;
}

export interface EndpointRow {
  sdk_name: string;
  method: string;
  path: string;
  kind: string;
  description: string | null;
  request_schema: unknown | null;
  response_schema: unknown | null;
  auth_scopes: string[];
}

export interface EmbeddingUpsert {
  ref_kind: 'sdk' | 'endpoint' | 'scenario' | 'ingest';
  ref_id: string;
  card: string;
  vector: Float32Array | number[];
}

export interface SearchHit {
  sdk_name: string;
  ref_kind: string;
  ref_id: string;
  score: number;
}

/** pgvector text literal, e.g. [0.0123,-0.4561,...]. */
function vecLiteral(v: Float32Array | number[]): string {
  return '[' + Array.from(v).join(',') + ']';
}

/** Current content hash for an SDK, or null if not yet indexed. */
export async function getSdkHash(name: string): Promise<string | null> {
  const row = await dataService.oneOn<{ content_hash: string }>(
    CATALOG_POOL,
    'SELECT content_hash FROM catalog.sdk WHERE name = $1',
    [name],
  );
  return row?.content_hash ?? null;
}

/** Upsert the SDK header row. */
export async function upsertSdk(row: SdkRow): Promise<void> {
  await dataService.queryOn(
    CATALOG_POOL,
    `INSERT INTO catalog.sdk (name, version, summary, tags, tier, pool_placement, content_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (name) DO UPDATE SET
       version = EXCLUDED.version,
       summary = EXCLUDED.summary,
       tags = EXCLUDED.tags,
       tier = EXCLUDED.tier,
       pool_placement = EXCLUDED.pool_placement,
       content_hash = EXCLUDED.content_hash,
       updated_at = now()`,
    [row.name, row.version, row.summary, row.tags, row.tier, row.pool_placement, row.content_hash],
  );
}

/** Replace an SDK's endpoints + embeddings atomically. */
export async function replaceSdkChildren(
  sdkName: string,
  endpoints: EndpointRow[],
  embeddings: EmbeddingUpsert[],
): Promise<void> {
  await dataService.tx(async (q: (sql: string, params?: unknown[]) => Promise<unknown>) => {
    await q('DELETE FROM catalog.endpoint WHERE sdk_name = $1', [sdkName]);
    for (const e of endpoints) {
      await q(
        `INSERT INTO catalog.endpoint
           (sdk_name, method, path, kind, description, request_schema, response_schema, auth_scopes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (sdk_name, method, path) DO UPDATE SET
           kind = EXCLUDED.kind, description = EXCLUDED.description,
           request_schema = EXCLUDED.request_schema, response_schema = EXCLUDED.response_schema,
           auth_scopes = EXCLUDED.auth_scopes`,
        [
          e.sdk_name, e.method, e.path, e.kind, e.description,
          e.request_schema ? JSON.stringify(e.request_schema) : null,
          e.response_schema ? JSON.stringify(e.response_schema) : null,
          e.auth_scopes,
        ],
      );
    }

    await q('DELETE FROM catalog.embedding WHERE sdk_name = $1', [sdkName]);
    for (const em of embeddings) {
      await q(
        `INSERT INTO catalog.embedding (ref_kind, ref_id, sdk_name, card, embedding)
         VALUES ($1,$2,$3,$4,$5::vector)
         ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
           sdk_name = EXCLUDED.sdk_name, card = EXCLUDED.card, embedding = EXCLUDED.embedding`,
        [em.ref_kind, em.ref_id, sdkName, em.card, vecLiteral(em.vector)],
      );
    }
  }, CATALOG_POOL);
}

/**
 * Semantic search over the catalog. Aggregates to the best score per SDK.
 * `kind` optionally restricts to a single ref_kind (e.g. 'ingest' for ETL).
 */
export async function searchCatalog(
  queryVector: Float32Array | number[],
  topK: number,
  opts: { kind?: EmbeddingUpsert['ref_kind'] } = {},
): Promise<SearchHit[]> {
  const lit = vecLiteral(queryVector);
  const where = opts.kind ? 'WHERE ref_kind = $2' : '';
  const params: unknown[] = opts.kind ? [lit, opts.kind, topK * 4] : [lit, topK * 4];
  const limitParam = opts.kind ? '$3' : '$2';

  const rows = await dataService.readRowsOn<{ sdk_name: string; ref_kind: string; ref_id: string; score: number }>(
    CATALOG_POOL,
    `SELECT sdk_name, ref_kind, ref_id, 1 - (embedding <=> $1::vector) AS score
     FROM catalog.embedding
     ${where}
     ORDER BY embedding <=> $1::vector
     LIMIT ${limitParam}`,
    params,
  );

  // Aggregate to best score per SDK, preserving order.
  const best = new Map<string, SearchHit>();
  for (const r of rows) {
    const prev = best.get(r.sdk_name);
    if (!prev || r.score > prev.score) best.set(r.sdk_name, r);
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Full endpoint contract (Epic D get_endpoint). */
export async function getEndpoint(sdkName: string, path: string): Promise<EndpointRow | null> {
  return dataService.readOneOn<EndpointRow>(
    CATALOG_POOL,
    `SELECT sdk_name, method, path, kind, description, request_schema, response_schema, auth_scopes
     FROM catalog.endpoint WHERE sdk_name = $1 AND path = $2`,
    [sdkName, path],
  );
}

/** Ingest/bulk endpoints, optionally filtered by an entity term in the path (Epic D get_ingest_targets). */
export async function getIngestTargets(entity?: string): Promise<EndpointRow[]> {
  const params: unknown[] = entity ? [`%${entity}%`] : [];
  return dataService.readRowsOn<EndpointRow>(
    CATALOG_POOL,
    `SELECT sdk_name, method, path, kind, description, request_schema, response_schema, auth_scopes
     FROM catalog.endpoint
     WHERE kind IN ('ingest','bulk')${entity ? ' AND path ILIKE $1' : ''}
     ORDER BY sdk_name, path`,
    params,
  );
}

/** Bump the single-row version marker so MCP hot-indexes know to reload. */
export async function bumpSyncVersion(): Promise<number> {
  const row = await dataService.oneOn<{ version: string }>(
    CATALOG_POOL,
    `UPDATE catalog.sync_state SET version = version + 1, synced_at = now() WHERE id = 1 RETURNING version`,
    [],
  );
  return row ? Number(row.version) : 0;
}

/** Current catalog version (for hot-index staleness checks). */
export async function getSyncVersion(): Promise<number> {
  const row = await dataService.readOneOn<{ version: string }>(
    CATALOG_POOL,
    'SELECT version FROM catalog.sync_state WHERE id = 1',
    [],
  );
  return row ? Number(row.version) : 0;
}

export interface CatalogSnapshotRow {
  ref_kind: string;
  ref_id: string;
  sdk_name: string;
  embedding: number[];
}

export interface CatalogSnapshot {
  version: number;
  rows: CatalogSnapshotRow[];
}

/**
 * Load the full embedding set for an in-memory hot index (TK-3478). The MCP
 * keeps this resident and answers search from memory (sub-ms, zero per-query
 * DB round-trip); it calls reloadIfChanged() to refresh only when the catalog
 * version bumps. For push-based reload, LISTEN on a 'catalog_synced' channel
 * (the sync job can NOTIFY after bumpSyncVersion()).
 */
export async function loadCatalogSnapshot(): Promise<CatalogSnapshot> {
  const version = await getSyncVersion();
  const rows = await dataService.readRowsOn<{ ref_kind: string; ref_id: string; sdk_name: string; embedding: string }>(
    CATALOG_POOL,
    `SELECT ref_kind, ref_id, sdk_name, embedding::text AS embedding FROM catalog.embedding`,
    [],
  );
  return {
    version,
    rows: rows.map((r) => ({
      ref_kind: r.ref_kind,
      ref_id: r.ref_id,
      sdk_name: r.sdk_name,
      // pgvector renders as "[a,b,c]" — parse back to numbers for cosine in memory.
      embedding: r.embedding.replace(/[[\]]/g, '').split(',').map(Number),
    })),
  };
}

/**
 * Reload helper for the hot index: returns a fresh snapshot only when the
 * catalog version advanced past `knownVersion`, else null (no work).
 */
export async function reloadIfChanged(knownVersion: number): Promise<CatalogSnapshot | null> {
  const version = await getSyncVersion();
  if (version <= knownVersion) return null;
  return loadCatalogSnapshot();
}
