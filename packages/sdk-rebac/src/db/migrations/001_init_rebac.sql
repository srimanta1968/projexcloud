-- Migration 001: sdk-rebac canonical schema per P2-Identity-Access-DataModel §9.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: rebac.{relationship, relationship_decision}
-- Hot path: rebac.reachability_cache lives in Redis (not Postgres), keyed by
-- (subject_persona_id, kind, depth_budget) and invalidated on relationship change.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS rebac;

-- rebac.relationship -- the edges of the graph (FR-REB-1)
CREATE TABLE IF NOT EXISTS rebac.relationship (
  relationship_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              TEXT NOT NULL,
  persona_a         UUID NOT NULL,
  persona_b         UUID NOT NULL,
  scope             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','active','suspended','terminated','expired')),
  consent_ref       UUID,
  expires_at        TIMESTAMPTZ,
  reattest_due_at   TIMESTAMPTZ,
  cross_tenant      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at     TIMESTAMPTZ,
  CHECK (persona_a <> persona_b)
);

-- Edge indexes (FR-REB-7) - sub-ms (kind, persona_a, persona_b) lookups
CREATE INDEX IF NOT EXISTS rel_kind_a_idx   ON rebac.relationship (kind, persona_a, persona_b) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS rel_kind_b_idx   ON rebac.relationship (kind, persona_b, persona_a) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS rel_status_idx   ON rebac.relationship (status, expires_at);
CREATE INDEX IF NOT EXISTS rel_reattest_idx ON rebac.relationship (reattest_due_at) WHERE reattest_due_at IS NOT NULL;

-- rebac.relationship_decision -- sampled decision log (FR-REB-10)
CREATE TABLE IF NOT EXISTS rebac.relationship_decision (
  decision_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_persona_id   UUID NOT NULL,
  target_persona_id    UUID NOT NULL,
  relationship_kind    TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason               TEXT NOT NULL,
  traversal_depth      INTEGER NOT NULL DEFAULT 0,
  projection_version   BIGINT NOT NULL DEFAULT 0,
  decided_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_subject_idx ON rebac.relationship_decision (subject_persona_id, decided_at DESC);
