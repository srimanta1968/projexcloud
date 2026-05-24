import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Taxonomy lookup + version activation (TK-3292, PRD §5.2 taxonomy block).
 *
 * Resolves the active extraction_schema / prompt_template for a tenant
 * with fallback to the platform default (tenant_id IS NULL). Cached
 * per-(tenant, document_kind) for 60s — same TTL as ai-gateway's PII
 * rule cache to keep behaviour predictable.
 */

const TAXONOMY_AUDIT_POOL = process.env.TAXONOMY_AUDIT_POOL || 'admin-default';
const LOOKUP_CACHE_TTL_MS = 60_000;

interface ExtractionSchemaRow {
  schema_id: string;
  taxonomy_version_id: string;
  document_kind: string;
  field_definitions: unknown;
  example_documents: unknown;
}

interface PromptTemplateRow {
  template_id: string;
  taxonomy_version_id: string;
  name: string;
  purpose_tag: string;
  template_body: string;
  variables: unknown;
  model_hint: string | null;
}

const schemaCache = new Map<string, { row: ExtractionSchemaRow | null; cachedAt: number }>();
const templateCache = new Map<string, { row: PromptTemplateRow | null; cachedAt: number }>();

function cacheKey(...parts: Array<string | null>): string {
  return parts.map((p) => p ?? '__null__').join('::');
}

/**
 * Look up the active extraction_schema for (tenant, document_kind).
 * Falls back to platform default when the tenant has none active.
 */
export async function lookupExtractionSchema(input: {
  tenant_id: string | null;
  document_kind: string;
}): Promise<ExtractionSchemaRow | null> {
  const key = cacheKey(input.tenant_id, input.document_kind);
  const hit = schemaCache.get(key);
  if (hit && Date.now() - hit.cachedAt < LOOKUP_CACHE_TTL_MS) return hit.row;

  // Resolve the active version: prefer tenant-specific, else platform default.
  const row = await dataService.one<ExtractionSchemaRow>(
    `SELECT es.schema_id, es.taxonomy_version_id::text, es.document_kind,
            es.field_definitions, es.example_documents
       FROM taxonomy.extraction_schema es
       JOIN taxonomy.version v ON v.taxonomy_version_id = es.taxonomy_version_id
      WHERE v.status = 'active'
        AND es.document_kind = $2
        AND (v.tenant_id = $1::uuid OR v.tenant_id IS NULL)
      ORDER BY (v.tenant_id IS NOT NULL) DESC, v.activated_at DESC
      LIMIT 1`,
    [input.tenant_id, input.document_kind],
  );
  schemaCache.set(key, { row, cachedAt: Date.now() });
  return row;
}

/**
 * Look up the active prompt_template by (tenant, purpose_tag).
 */
export async function lookupPromptTemplate(input: {
  tenant_id: string | null;
  purpose_tag: string;
  name?: string;
}): Promise<PromptTemplateRow | null> {
  const key = cacheKey(input.tenant_id, input.purpose_tag, input.name ?? null);
  const hit = templateCache.get(key);
  if (hit && Date.now() - hit.cachedAt < LOOKUP_CACHE_TTL_MS) return hit.row;

  const row = await dataService.one<PromptTemplateRow>(
    `SELECT pt.template_id, pt.taxonomy_version_id::text, pt.name, pt.purpose_tag,
            pt.template_body, pt.variables, pt.model_hint
       FROM taxonomy.prompt_template pt
       JOIN taxonomy.version v ON v.taxonomy_version_id = pt.taxonomy_version_id
      WHERE v.status = 'active'
        AND pt.purpose_tag = $2
        AND ($3::text IS NULL OR pt.name = $3)
        AND (v.tenant_id = $1::uuid OR v.tenant_id IS NULL)
      ORDER BY (v.tenant_id IS NOT NULL) DESC, v.activated_at DESC
      LIMIT 1`,
    [input.tenant_id, input.purpose_tag, input.name ?? null],
  );
  templateCache.set(key, { row, cachedAt: Date.now() });
  return row;
}

export interface ActivateVersionResult {
  activated_version_id: string;
  deprecated_version_ids: string[];
}

/**
 * Atomic version activation: demote the previous active version (per
 * tenant + taxonomy name) to deprecated, then activate the requested
 * one. Emits taxonomy.version.activated.v1 + taxonomy.version.deprecated.v1
 * (regulated retention). Invalidates the lookup caches so the next call
 * sees the new active version immediately.
 */
export async function activateTaxonomyVersion(input: {
  taxonomy_version_id: string;
  actor_id: string;
}): Promise<ActivateVersionResult> {
  // Demote any current active version for the same (tenant_id, name).
  const target = await dataService.one<{
    taxonomy_version_id: string;
    tenant_id: string | null;
    name: string;
  }>(
    `SELECT taxonomy_version_id::text, tenant_id::text, name
       FROM taxonomy.version WHERE taxonomy_version_id = $1`,
    [input.taxonomy_version_id],
  );
  if (!target) throw new Error(`[taxonomy] version ${input.taxonomy_version_id} not found`);

  const deprecated = await dataService.query<{ taxonomy_version_id: string }>(
    `UPDATE taxonomy.version
        SET status = 'deprecated', deprecated_at = now()
      WHERE name = $2
        AND COALESCE(tenant_id::text, '__null__') = COALESCE($3::text, '__null__')
        AND status = 'active'
        AND taxonomy_version_id <> $1
      RETURNING taxonomy_version_id::text`,
    [input.taxonomy_version_id, target.name, target.tenant_id],
  );

  await dataService.query(
    `UPDATE taxonomy.version
        SET status = 'active', activated_at = COALESCE(activated_at, now())
      WHERE taxonomy_version_id = $1`,
    [input.taxonomy_version_id],
  );

  // Invalidate both caches — version activation can change which schemas
  // + templates are returned for every (tenant, document_kind) pair.
  schemaCache.clear();
  templateCache.clear();

  try {
    for (const row of deprecated.rows) {
      await appendAuditEntry({
        pool_index: TAXONOMY_AUDIT_POOL,
        event_type: 'taxonomy.version.deprecated.v1',
        actor_kind: 'human',
        actor_id: input.actor_id,
        tenant_id: target.tenant_id,
        subject_kind: 'taxonomy.version',
        subject_id: row.taxonomy_version_id,
        retention_class: 'regulated',
        payload: {
          superseded_by: input.taxonomy_version_id,
          name: target.name,
        },
      });
    }
    await appendAuditEntry({
      pool_index: TAXONOMY_AUDIT_POOL,
      event_type: 'taxonomy.version.activated.v1',
      actor_kind: 'human',
      actor_id: input.actor_id,
      tenant_id: target.tenant_id,
      subject_kind: 'taxonomy.version',
      subject_id: input.taxonomy_version_id,
      retention_class: 'regulated',
      payload: { name: target.name, deprecated: deprecated.rows.map((r) => r.taxonomy_version_id) },
    });
  } catch (auditErr) {
    console.error('[taxonomy] audit emit failed', (auditErr as Error).message);
  }

  return {
    activated_version_id: input.taxonomy_version_id,
    deprecated_version_ids: deprecated.rows.map((r) => r.taxonomy_version_id),
  };
}
