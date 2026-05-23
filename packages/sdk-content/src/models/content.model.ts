export type ItemStatus = 'draft' | 'published' | 'archived';

export interface ItemRecord {
  item_id: string;
  tenant_id: string;
  type_code: string;
  slug: string;
  status: ItemStatus;
  owner_persona_id: string | null;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VersionRecord {
  version_id: string;
  item_id: string;
  version_no: number;
  payload: Record<string, unknown>;
  media_refs: string[];
  taxonomy_tags: string[];
  published_at: Date | null;
  published_by: string | null;
}

export interface TaxonomyRecord {
  taxonomy_id: string;
  tenant_id: string;
  name: string;
  structure: Record<string, unknown>;
  created_at: Date;
}

export interface CreateItemInput {
  tenant_id: string;
  type_code: string;
  slug: string;
  owner_persona_id?: string;
}

export interface CreateVersionInput {
  item_id: string;
  payload: Record<string, unknown>;
  media_refs?: string[];
  taxonomy_tags?: string[];
}
