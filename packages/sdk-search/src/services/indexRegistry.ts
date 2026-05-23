import { dataService } from '@projexlight/db-runtime';
import { getSearchClient, resolveIndexName } from './searchClient';
import type {
  IndexDefinitionRecord,
  IndexDocumentInput,
  RegisterIndexInput,
} from '../models/search.model';

/**
 * Per-tenant index metadata registry per FR-SRC-2,3.
 *
 * registerIndex() upserts a search.index_definition row + ensures the
 * physical OpenSearch index exists with the supplied field mappings.
 * indexDocument() writes the doc through the SearchClient with scope_tags
 * stamped into _scope_tags for downstream ABAC filtering.
 */

const DEFAULT_FIELD_MAPPINGS: Record<string, unknown> = {
  properties: {
    tenant_id: { type: 'keyword' },
    _scope_tags: { type: 'keyword' },
    _searchable: { type: 'text' },
  },
};

export async function registerIndex(input: RegisterIndexInput): Promise<IndexDefinitionRecord> {
  const opensearch_alias = input.opensearch_alias
    ?? resolveIndexName(input.tenant_id, input.entity_kind);
  const field_mappings = input.field_mappings ?? DEFAULT_FIELD_MAPPINGS;

  // De-active any prior 'active' row to keep partial-uniq index happy.
  await dataService.query(
    `UPDATE search.index_definition
        SET status = 'deprecated', updated_at = now()
      WHERE tenant_id = $1 AND entity_kind = $2 AND status = 'active'`,
    [input.tenant_id, input.entity_kind],
  );

  const rows = await dataService.rows<IndexDefinitionRecord>(
    `INSERT INTO search.index_definition (
       tenant_id, entity_kind, opensearch_alias, field_mappings, status
     ) VALUES ($1, $2, $3, $4::jsonb, 'active')
     RETURNING index_def_id, tenant_id, entity_kind, opensearch_alias,
               field_mappings, status, created_at, updated_at`,
    [
      input.tenant_id,
      input.entity_kind,
      opensearch_alias,
      JSON.stringify(field_mappings),
    ],
  );

  const def = rows[0];

  // Ensure the physical index exists in OpenSearch.
  await getSearchClient().ensureIndex(def.opensearch_alias, { mappings: def.field_mappings });

  return def;
}

export async function getActiveDefinition(
  tenant_id: string,
  entity_kind: string,
): Promise<IndexDefinitionRecord | null> {
  return dataService.one<IndexDefinitionRecord>(
    `SELECT index_def_id, tenant_id, entity_kind, opensearch_alias, field_mappings,
            status, created_at, updated_at
       FROM search.index_definition
      WHERE tenant_id = $1 AND entity_kind = $2 AND status = 'active'`,
    [tenant_id, entity_kind],
  );
}

/**
 * Index a single document under (tenant, entity_kind). Auto-registers the
 * index with defaults if it doesn't exist (FR-SRC-4: indexers can write
 * without a separate registration step).
 */
export async function indexDocument(input: IndexDocumentInput): Promise<{
  index_used: string;
}> {
  let def = await getActiveDefinition(input.tenant_id, input.entity_kind);
  if (!def) {
    def = await registerIndex({
      tenant_id: input.tenant_id,
      entity_kind: input.entity_kind,
    });
  }
  const source = {
    ...input.doc,
    tenant_id: input.tenant_id,
    _scope_tags: input.scope_tags ?? [],
    _searchable: buildSearchableBlob(input.doc),
  };
  await getSearchClient().index(def.opensearch_alias, input.doc_id, source);

  // Touch the partition row so dashboards can read recency.
  await dataService.query(
    `INSERT INTO search.index_partition (index_def_id, pool_index, shard, last_indexed_at, doc_count)
     VALUES ($1, 0, 0, now(), 1)
     ON CONFLICT (index_def_id, pool_index, shard) DO UPDATE
       SET last_indexed_at = now(), doc_count = search.index_partition.doc_count + 1`,
    [def.index_def_id],
  );

  return { index_used: def.opensearch_alias };
}

function buildSearchableBlob(doc: Record<string, unknown>): string {
  return Object.values(doc)
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .slice(0, 4000);
}

export async function deleteDocument(
  tenant_id: string,
  entity_kind: string,
  doc_id: string,
): Promise<void> {
  const def = await getActiveDefinition(tenant_id, entity_kind);
  if (!def) return;
  await getSearchClient().delete(def.opensearch_alias, doc_id);
}
