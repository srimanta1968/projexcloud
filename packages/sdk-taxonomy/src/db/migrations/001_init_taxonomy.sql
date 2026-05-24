-- Migration 001: sdk-taxonomy canonical schema per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §5.
-- Auto-applied by @projexlight/migration-runner against the Admin pool.
--
-- Tables: taxonomy.version (draft -> active -> deprecated -> retired),
--         taxonomy.extraction_schema (per document_kind, FK to version),
--         taxonomy.prompt_template (variable schema + model hint),
--         taxonomy.migration_plan (version N -> N+1 transformations).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS taxonomy;

CREATE TABLE IF NOT EXISTS taxonomy.version (
  taxonomy_version_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','active','deprecated','retired')),
  parent_version_id    UUID REFERENCES taxonomy.version(taxonomy_version_id) ON DELETE RESTRICT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at         TIMESTAMPTZ,
  deprecated_at        TIMESTAMPTZ,
  retired_at           TIMESTAMPTZ,
  CONSTRAINT taxonomy_version_unique UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS taxonomy_version_active_idx
  ON taxonomy.version (COALESCE(tenant_id::text, ''), name, status);

CREATE TABLE IF NOT EXISTS taxonomy.extraction_schema (
  schema_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_version_id  UUID NOT NULL REFERENCES taxonomy.version(taxonomy_version_id) ON DELETE RESTRICT,
  document_kind        TEXT NOT NULL,
  field_definitions    JSONB NOT NULL,
  example_documents    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT extraction_schema_unique UNIQUE (taxonomy_version_id, document_kind)
);

CREATE INDEX IF NOT EXISTS extraction_schema_doc_kind_idx
  ON taxonomy.extraction_schema (document_kind);

CREATE TABLE IF NOT EXISTS taxonomy.prompt_template (
  template_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_version_id  UUID NOT NULL REFERENCES taxonomy.version(taxonomy_version_id) ON DELETE RESTRICT,
  name                 TEXT NOT NULL,
  purpose_tag          TEXT NOT NULL,
  template_body        TEXT NOT NULL,
  variables            JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_hint           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prompt_template_unique UNIQUE (taxonomy_version_id, name)
);

CREATE INDEX IF NOT EXISTS prompt_template_purpose_idx
  ON taxonomy.prompt_template (purpose_tag);

CREATE TABLE IF NOT EXISTS taxonomy.migration_plan (
  plan_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_version_id      UUID NOT NULL REFERENCES taxonomy.version(taxonomy_version_id) ON DELETE RESTRICT,
  to_version_id        UUID NOT NULL REFERENCES taxonomy.version(taxonomy_version_id) ON DELETE RESTRICT,
  transformations      JSONB NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migration_plan_unique UNIQUE (from_version_id, to_version_id),
  CONSTRAINT migration_plan_distinct_versions CHECK (from_version_id <> to_version_id)
);

COMMENT ON SCHEMA taxonomy IS 'sdk-taxonomy canonical schema · P6A §5.2 (taxonomy block).';
COMMENT ON COLUMN taxonomy.version.tenant_id
  IS 'Null = platform default; non-null = tenant override.';
