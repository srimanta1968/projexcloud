-- Migration 001: identity projection schema per P2-Identity-Access-DataModel §10.
-- The G4 closer: precomputed subject_view per (person, app, tenant) so the
-- hot path is a Redis read, not a six-layer graph walk.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS projection;

-- projection.subject_view -- the materialized (person, app, tenant) row (FR-IPS-1)
-- projection_version is a monotonic counter bumped on every refresh (FR-IPS-6).
-- Policy precomp cache keys include this version, so a bump implicitly
-- invalidates every cached decision for the subject (no scan/delete needed).
CREATE TABLE IF NOT EXISTS projection.subject_view (
  person_id              UUID NOT NULL,
  app_id                 TEXT NOT NULL,
  tenant_id              UUID NOT NULL,
  bu_id                  UUID,
  primary_persona_id     UUID,
  all_persona_ids        UUID[] NOT NULL DEFAULT '{}'::UUID[],
  role_template_id       UUID,
  effective_role_closure TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  reachable_personas     UUID[] NOT NULL DEFAULT '{}'::UUID[],
  consents_granted       TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  admin_pool_index       TEXT,
  app_pool_index         TEXT,
  projection_version     BIGINT NOT NULL DEFAULT 1,
  refreshed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, app_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS subject_view_person_idx ON projection.subject_view (person_id);
CREATE INDEX IF NOT EXISTS subject_view_tenant_idx ON projection.subject_view (tenant_id);
CREATE INDEX IF NOT EXISTS subject_view_ttl_idx    ON projection.subject_view (refreshed_at);
