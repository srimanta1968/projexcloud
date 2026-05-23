-- Migration 001: sdk-feature-flags canonical schema per P3-Canonical-Privacy-HDK-DataModel §10.1.
-- Auto-applied by @projexlight/migration-runner.
-- Tables: feature_flags.{flag, rollout, evaluation_sample}.
-- FR-FF-1..5.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS feature_flags;

CREATE TABLE IF NOT EXISTS feature_flags.flag (
  flag_id         TEXT PRIMARY KEY,
  description     TEXT,
  kind            TEXT NOT NULL DEFAULT 'boolean'
                    CHECK (kind IN ('boolean','variant','numeric','json')),
  default_value   JSONB NOT NULL DEFAULT 'false'::jsonb,
  kill_switch     BOOLEAN NOT NULL DEFAULT FALSE,
  schema_ref      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flag_kill_idx ON feature_flags.flag (kill_switch) WHERE kill_switch = TRUE;

CREATE TABLE IF NOT EXISTS feature_flags.rollout (
  rollout_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id          TEXT NOT NULL REFERENCES feature_flags.flag(flag_id) ON DELETE CASCADE,
  tenant_id        UUID,
  predicate        JSONB NOT NULL DEFAULT '{}'::jsonb,
  value            JSONB NOT NULL,
  priority         INT NOT NULL DEFAULT 100,
  -- FR-FF-3: % rollout bucket 0..100. NULL = predicate-only (no % gate).
  rollout_percent  INT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rollout_percent IS NULL OR (rollout_percent BETWEEN 0 AND 100))
);

CREATE INDEX IF NOT EXISTS rollout_flag_idx     ON feature_flags.rollout (flag_id, active, priority);
CREATE INDEX IF NOT EXISTS rollout_tenant_idx   ON feature_flags.rollout (tenant_id, active) WHERE tenant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS feature_flags.evaluation_sample (
  sample_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id            TEXT NOT NULL,
  tenant_id          TEXT,
  persona_id         TEXT,
  resolved_value     JSONB NOT NULL,
  matched_rollout_id UUID,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evaluation_sample_flag_idx ON feature_flags.evaluation_sample (flag_id, occurred_at DESC);

COMMENT ON TABLE feature_flags.flag IS 'Per-flag definition. kill_switch=TRUE participates in emergency-kill paths.';
COMMENT ON TABLE feature_flags.rollout IS 'Per-tenant rollouts. tenant_id NULL = platform-wide.';
COMMENT ON TABLE feature_flags.evaluation_sample IS 'Sampled telemetry of flag evaluations.';
