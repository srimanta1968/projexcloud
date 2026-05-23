-- Migration 001: sdk-content per P5 DataModel §6. Auto-applied via api-gateway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE IF NOT EXISTS content.taxonomy (
  taxonomy_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  structure     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS content.item (
  item_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  type_code            TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','published','archived')),
  owner_persona_id     UUID,
  current_version_id   UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type_code, slug)
);

CREATE INDEX IF NOT EXISTS content_item_tenant_idx ON content.item (tenant_id, status);

CREATE TABLE IF NOT EXISTS content.version (
  version_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id              UUID NOT NULL REFERENCES content.item(item_id) ON DELETE CASCADE,
  version_no           INT NOT NULL,
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  media_refs           TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  taxonomy_tags        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  published_at         TIMESTAMPTZ,
  published_by         UUID,
  UNIQUE (item_id, version_no)
);

CREATE INDEX IF NOT EXISTS content_version_item_idx ON content.version (item_id, version_no DESC);

-- back-fill current_version_id FK target (table-level deferred FK)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_current_version_fk') THEN
    ALTER TABLE content.item ADD CONSTRAINT item_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES content.version(version_id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE content.item     IS 'Typed content item; current_version_id points to published version.';
COMMENT ON TABLE content.version  IS 'Append-only version history per item.';
COMMENT ON TABLE content.taxonomy IS 'Tenant-defined classification hierarchy.';
