import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  CreateItemInput,
  CreateVersionInput,
  ItemRecord,
  ItemStatus,
  TaxonomyRecord,
  VersionRecord,
} from '../models/content.model';

const CONTENT_AUDIT_POOL = process.env.CONTENT_AUDIT_POOL || 'admin-default';

async function emitContentAudit(opts: {
  event_type: 'content.item.created.v1' | 'content.version.published.v1';
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class?: 'operational' | 'regulated';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: CONTENT_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      tenant_id: opts.tenant_id,
      subject_kind: opts.subject_kind,
      subject_id: opts.subject_id,
      retention_class: opts.retention_class ?? 'regulated',
      payload: opts.payload,
    });
  } catch (err) {
    console.error('[sdk-content] audit emit failed', opts.event_type, (err as Error).message);
  }
}

export async function createItem(input: CreateItemInput): Promise<ItemRecord> {
  const rows = await dataService.rows<ItemRecord>(
    `INSERT INTO content.item (tenant_id, type_code, slug, owner_persona_id)
     VALUES ($1, $2, $3, $4)
     RETURNING item_id, tenant_id, type_code, slug, status,
               owner_persona_id, current_version_id, created_at, updated_at`,
    [input.tenant_id, input.type_code, input.slug, input.owner_persona_id ?? null],
  );
  const item = rows[0];
  await emitContentAudit({
    event_type: 'content.item.created.v1',
    tenant_id: item.tenant_id,
    subject_kind: 'content.item',
    subject_id: item.item_id,
    actor_id: 'sdk-content.createItem',
    payload: { type_code: item.type_code, slug: item.slug },
    retention_class: 'operational',
  });
  return item;
}

export async function createVersion(input: CreateVersionInput): Promise<VersionRecord> {
  // Atomically allocate next version_no by looking at the max for the item.
  const nextNo = await dataService.one<{ next_no: number }>(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
       FROM content.version WHERE item_id = $1`,
    [input.item_id],
  );
  const rows = await dataService.rows<VersionRecord>(
    `INSERT INTO content.version (item_id, version_no, payload, media_refs, taxonomy_tags)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING version_id, item_id, version_no, payload, media_refs,
               taxonomy_tags, published_at, published_by`,
    [
      input.item_id,
      nextNo?.next_no ?? 1,
      JSON.stringify(input.payload ?? {}),
      input.media_refs ?? [],
      input.taxonomy_tags ?? [],
    ],
  );
  return rows[0];
}

export async function publishVersion(item_id: string, version_id: string, published_by: string): Promise<ItemRecord | null> {
  await dataService.query(
    `UPDATE content.version SET published_at = now(), published_by = $1 WHERE version_id = $2`,
    [published_by, version_id],
  );
  const rows = await dataService.rows<ItemRecord>(
    `UPDATE content.item
        SET status = 'published', current_version_id = $2, updated_at = now()
      WHERE item_id = $1
      RETURNING item_id, tenant_id, type_code, slug, status,
                owner_persona_id, current_version_id, created_at, updated_at`,
    [item_id, version_id],
  );
  const item = rows[0] ?? null;
  if (item) {
    await emitContentAudit({
      event_type: 'content.version.published.v1',
      tenant_id: item.tenant_id,
      subject_kind: 'content.item',
      subject_id: item.item_id,
      actor_id: published_by,
      payload: { version_id, type_code: item.type_code, slug: item.slug },
    });
  }
  return item;
}

export async function archiveItem(item_id: string): Promise<ItemRecord | null> {
  const rows = await dataService.rows<ItemRecord>(
    `UPDATE content.item SET status = 'archived', updated_at = now()
      WHERE item_id = $1 AND status <> 'archived'
      RETURNING item_id, tenant_id, type_code, slug, status,
                owner_persona_id, current_version_id, created_at, updated_at`,
    [item_id],
  );
  return rows[0] ?? null;
}

export async function getItem(item_id: string): Promise<ItemRecord | null> {
  return dataService.one<ItemRecord>(
    `SELECT item_id, tenant_id, type_code, slug, status,
            owner_persona_id, current_version_id, created_at, updated_at
       FROM content.item WHERE item_id = $1`,
    [item_id],
  );
}

export async function listVersions(item_id: string): Promise<VersionRecord[]> {
  return dataService.rows<VersionRecord>(
    `SELECT version_id, item_id, version_no, payload, media_refs,
            taxonomy_tags, published_at, published_by
       FROM content.version WHERE item_id = $1 ORDER BY version_no DESC`,
    [item_id],
  );
}

export async function upsertTaxonomy(tenant_id: string, name: string, structure: Record<string, unknown>): Promise<TaxonomyRecord> {
  const rows = await dataService.rows<TaxonomyRecord>(
    `INSERT INTO content.taxonomy (tenant_id, name, structure)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, name) DO UPDATE SET structure = EXCLUDED.structure
     RETURNING taxonomy_id, tenant_id, name, structure, created_at`,
    [tenant_id, name, JSON.stringify(structure)],
  );
  return rows[0];
}

export { type ItemStatus };
