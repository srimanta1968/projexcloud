-- Migration 001: connector-salesforce mirror tables per P5 DataModel §11.2.
-- Auto-applied via api-gateway runMigrations. Vendor mirrors live in their
-- own schema; common framework tables (install/cursor/tool_manifest) live
-- in the `connectors` schema from @projexlight/sdk-connectors.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_salesforce;

CREATE TABLE IF NOT EXISTS connector_salesforce.sf_account (
  mirror_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  external_id        TEXT NOT NULL,
  canonical_persona_id UUID,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag     TEXT,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','deleted-upstream')),
  UNIQUE (install_id, external_id)
);
CREATE INDEX IF NOT EXISTS sf_account_install_idx ON connector_salesforce.sf_account (install_id, last_sync_at DESC);

CREATE TABLE IF NOT EXISTS connector_salesforce.sf_contact (
  mirror_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  external_id        TEXT NOT NULL,
  canonical_persona_id UUID,
  canonical_contact_id UUID,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag     TEXT,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL DEFAULT 'active',
  UNIQUE (install_id, external_id)
);

CREATE TABLE IF NOT EXISTS connector_salesforce.sf_lead (
  mirror_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  external_id        TEXT NOT NULL,
  canonical_lead_id  UUID,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag     TEXT,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL DEFAULT 'active',
  UNIQUE (install_id, external_id)
);

CREATE TABLE IF NOT EXISTS connector_salesforce.sf_opportunity (
  mirror_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  external_id        TEXT NOT NULL,
  canonical_deal_id  UUID,
  canonical_encounter_id UUID,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag     TEXT,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL DEFAULT 'active',
  UNIQUE (install_id, external_id)
);

COMMENT ON SCHEMA connector_salesforce IS 'Salesforce mirror tables. Common install/cursor/tool_manifest live in the connectors schema.';
