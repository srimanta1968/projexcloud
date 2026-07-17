-- Migration 003: sdk-sequence — frequency-cap + circuit-breaker guard engine.
-- P14·E1. Auto-applied by the migration runner at boot.
--
-- Ports the outreach-orchestrator guard engine: per-lead cooldown, max-messages
-- per rolling window, content dedup, a per-(tenant,channel) circuit breaker, and
-- an append-only guard audit log of every allow/block decision.
--
-- Additive to 001/002; idempotent (IF NOT EXISTS). Down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Per-tenant guard configuration. A missing row means "use the defaults".
CREATE TABLE IF NOT EXISTS sequence.guard_config (
  tenant_id                 UUID PRIMARY KEY,
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  cooldown_seconds          INTEGER NOT NULL DEFAULT 3600  CHECK (cooldown_seconds >= 0),
  max_messages              INTEGER NOT NULL DEFAULT 5     CHECK (max_messages >= 0),
  window_seconds            INTEGER NOT NULL DEFAULT 86400 CHECK (window_seconds > 0),
  breaker_failure_threshold INTEGER NOT NULL DEFAULT 5     CHECK (breaker_failure_threshold >= 1),
  breaker_cooldown_seconds  INTEGER NOT NULL DEFAULT 300   CHECK (breaker_cooldown_seconds >= 0),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-(tenant, channel) circuit breaker state. Opens after too many failures,
-- half-opens after the cooldown to probe, closes on the first success.
CREATE TABLE IF NOT EXISTS sequence.circuit_breaker (
  tenant_id     UUID NOT NULL,
  channel       TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  opened_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

-- Append-only audit log of every guard decision (guard evidence trail).
CREATE TABLE IF NOT EXISTS sequence.guard_log (
  guard_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  subject_persona_id UUID,
  channel            TEXT,
  decision           TEXT NOT NULL CHECK (decision IN ('allow','block')),
  reason             TEXT,
  execution_step_id  UUID,
  dedupe_hash        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sequence_guard_log_tenant_idx
  ON sequence.guard_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sequence_guard_log_subject_idx
  ON sequence.guard_log (tenant_id, subject_persona_id, created_at DESC);
-- Dedup lookups: was this exact content already allowed for the subject recently?
CREATE INDEX IF NOT EXISTS sequence_guard_log_dedupe_idx
  ON sequence.guard_log (tenant_id, dedupe_hash, created_at DESC) WHERE dedupe_hash IS NOT NULL;

COMMENT ON TABLE sequence.guard_config    IS 'Per-tenant frequency-cap + breaker config (P14·E1). Missing row => defaults.';
COMMENT ON TABLE sequence.circuit_breaker IS 'Per-(tenant,channel) circuit breaker: closed -> open -> half_open -> closed.';
COMMENT ON TABLE sequence.guard_log       IS 'Append-only guard decision audit log (cooldown/max_messages/duplicate/circuit_open + allow).';
