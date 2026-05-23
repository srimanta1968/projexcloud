-- Migration 001: sdk-policy canonical schema per P2-Identity-Access-DataModel §8.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: policy.{policy, decision, attribute_fetcher}
-- Hot Redis cache (policy.precomp_cache) is not a Postgres table — managed by
-- @projexlight/redis-runtime keyed by (policy_id, subject_id, target_id,
-- projection_version) and invalidated when projection_version bumps.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS policy;

-- policy.policy -- versioned policy bundle (FR-POL-1, FR-POL-4)
CREATE TABLE IF NOT EXISTS policy.policy (
  policy_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID,
  name             TEXT NOT NULL,
  iql_source       TEXT NOT NULL,
  cedar_compiled   JSONB NOT NULL DEFAULT '{}'::jsonb,
  version          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('draft','active','deprecated','retired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS policy_active_idx ON policy.policy (tenant_id, status) WHERE status = 'active';

-- policy.attribute_fetcher -- registered fetchers used by IQL evaluator (FR-POL-5)
CREATE TABLE IF NOT EXISTS policy.attribute_fetcher (
  fetcher_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL CHECK (source IN ('mdm','projection','inline')),
  returns_type  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- policy.decision -- sampled decision log; ALLOW/DENY on regulated targets also flows to audit
CREATE TABLE IF NOT EXISTS policy.decision (
  decision_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id            UUID NOT NULL REFERENCES policy.policy(policy_id) ON DELETE RESTRICT,
  subject_id           UUID NOT NULL,
  target_id            UUID,
  decision             TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  reason               TEXT NOT NULL,
  layers_used          TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  projection_version   BIGINT NOT NULL DEFAULT 0,
  decided_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_policy_idx ON policy.decision (policy_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS decision_subject_idx ON policy.decision (subject_id, decided_at DESC);
