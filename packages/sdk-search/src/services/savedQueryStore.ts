import { dataService } from '@projexlight/db-runtime';
import type { SaveQueryInput, SavedQueryRecord } from '../models/search.model';

/**
 * Saved query CRUD per FR-SRC-5.
 *
 * The stored DSL does NOT include ABAC filters — those are re-applied at
 * execute time so a saved query honors the CURRENT scope of whoever runs
 * it. Example: an analyst saves "all encounters where status=open"; later
 * their scope is narrowed; the next execution returns only the subset they
 * are now allowed to see, with no edits to the stored query.
 */

export async function saveQuery(input: SaveQueryInput): Promise<SavedQueryRecord> {
  const rows = await dataService.rows<SavedQueryRecord>(
    `INSERT INTO search.saved_query (tenant_id, persona_id, name, dsl)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, persona_id, name) DO UPDATE
       SET dsl = EXCLUDED.dsl
     RETURNING query_id, tenant_id, persona_id, name, dsl, created_at`,
    [input.tenant_id, input.persona_id, input.name, JSON.stringify(input.dsl)],
  );
  return rows[0];
}

export async function getSavedQuery(
  tenant_id: string,
  persona_id: string,
  name: string,
): Promise<SavedQueryRecord | null> {
  return dataService.one<SavedQueryRecord>(
    `SELECT query_id, tenant_id, persona_id, name, dsl, created_at
       FROM search.saved_query
      WHERE tenant_id = $1 AND persona_id = $2 AND name = $3`,
    [tenant_id, persona_id, name],
  );
}

export async function listSavedQueries(
  tenant_id: string,
  persona_id: string,
): Promise<SavedQueryRecord[]> {
  return dataService.rows<SavedQueryRecord>(
    `SELECT query_id, tenant_id, persona_id, name, dsl, created_at
       FROM search.saved_query
      WHERE tenant_id = $1 AND persona_id = $2
      ORDER BY created_at DESC`,
    [tenant_id, persona_id],
  );
}

export async function deleteSavedQuery(
  tenant_id: string,
  persona_id: string,
  name: string,
): Promise<void> {
  await dataService.query(
    `DELETE FROM search.saved_query
      WHERE tenant_id = $1 AND persona_id = $2 AND name = $3`,
    [tenant_id, persona_id, name],
  );
}
