-- Migration 001: sdk-sequence — multi-touch cadence orchestration engine.
-- P14 · E1 (TK-3612). Auto-applied by the migration runner at boot.
--
-- Parity with projex_crm outreach_* (outreach_sequences, outreach_templates,
-- sequence_execution_steps, stage_sequence_triggers) — RE-HOMED as a reusable
-- SDK, tenant-scoped, and NORMALIZED: the projex_crm `steps` JSONB blob becomes
-- a first-class `sequence.step` table, and the single-tenant `user_id` /
-- `organization_id` scoping becomes `tenant_id`.
--
-- Coupling dropped: no FK to projex_crm `prospects` / `prospect_stage`. The
-- enrolled subject is keyed on an L4 `subject_persona_id` (ProjexCloud identity
-- spine), matching sdk-campaign.journey_run — any domain entity (lead / contact
-- / deal) resolves to its persona.
--
-- Idempotent + re-runnable: every object uses IF NOT EXISTS. A companion
-- rollback lives in ../down/001_init_sequence.down.sql (not auto-applied — the
-- runner is forward-only).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS sequence;

-- ---------------------------------------------------------------- sequence.template
-- Reusable channel message body (parity: outreach_templates). Referenced by
-- steps; created first so step.template_id FK resolves.
CREATE TABLE IF NOT EXISTS sequence.template (
  template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'email'
                  CHECK (channel IN ('email','sms','call','linkedin','task')),
  subject       TEXT,
  body          TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'custom',
  variables     JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS sequence_template_tenant_idx
  ON sequence.template (tenant_id, category);

-- ---------------------------------------------------------------- sequence.sequence
-- The cadence definition (parity: outreach_sequences). Tenant-scoped; the
-- `steps` JSONB of the source is normalized into sequence.step below.
CREATE TABLE IF NOT EXISTS sequence.sequence (
  sequence_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  owner_persona_id   UUID,
  name               TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','paused','archived')),
  sequence_type      TEXT NOT NULL DEFAULT 'lead'
                       CHECK (sequence_type IN ('lead','customer','onboarding','nurture','custom')),
  entity_id          UUID,
  entity_type        TEXT,
  is_default         BOOLEAN NOT NULL DEFAULT false,
  is_auto_generated  BOOLEAN NOT NULL DEFAULT false,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sequence_sequence_tenant_idx
  ON sequence.sequence (tenant_id, status);
CREATE INDEX IF NOT EXISTS sequence_sequence_entity_idx
  ON sequence.sequence (entity_id, entity_type) WHERE entity_id IS NOT NULL;
-- At most one default sequence per (tenant, type) — parity with the source's
-- idx_seq_org_type_default partial-unique guard.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_sequence_default_idx
  ON sequence.sequence (tenant_id, sequence_type) WHERE is_default;

-- ---------------------------------------------------------------- sequence.step
-- Normalized step definition (was outreach_sequences.steps JSONB). One row per
-- ordered touch in a sequence.
CREATE TABLE IF NOT EXISTS sequence.step (
  step_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sequence_id    UUID NOT NULL REFERENCES sequence.sequence(sequence_id) ON DELETE CASCADE,
  step_number    INTEGER NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'email'
                   CHECK (channel IN ('email','sms','call','linkedin','task','wait')),
  action         TEXT NOT NULL DEFAULT 'send'
                   CHECK (action IN ('send','wait','book','task','branch')),
  template_id    UUID REFERENCES sequence.template(template_id) ON DELETE SET NULL,
  subject        TEXT,
  body           TEXT,
  schedule_mode  TEXT NOT NULL DEFAULT 'delay'
                   CHECK (schedule_mode IN ('delay','absolute','immediate')),
  delay_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),
  send_mode      TEXT NOT NULL DEFAULT 'individual'
                   CHECK (send_mode IN ('individual','bulk')),
  trigger_type   TEXT,
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  variations     JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_number)
);

CREATE INDEX IF NOT EXISTS sequence_step_tenant_idx
  ON sequence.step (tenant_id, sequence_id);

-- ---------------------------------------------------------------- sequence.execution_step
-- Runtime execution state (parity: sequence_execution_steps). Each row is one
-- scheduled touch for one enrolled subject; enrollment_id groups a subject's
-- whole run through a sequence. This is the table the step-executor tick loop
-- (TK-3614) polls.
CREATE TABLE IF NOT EXISTS sequence.execution_step (
  execution_step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  enrollment_id     UUID NOT NULL,
  sequence_id       UUID NOT NULL REFERENCES sequence.sequence(sequence_id) ON DELETE CASCADE,
  step_id           UUID REFERENCES sequence.step(step_id) ON DELETE SET NULL,
  step_number       INTEGER NOT NULL,
  -- Identity-based (ProjexCloud spine): the enrolled subject is an L4 persona,
  -- exactly as sdk-campaign.journey_run.subject_persona_id. Domain type (lead /
  -- contact / deal) is resolved via projection.subject_view, not stored here.
  subject_persona_id UUID NOT NULL,
  channel           TEXT,
  action            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','scheduled','sending','sent','skipped','failed','canceled','deferred')),
  next_run_at       TIMESTAMPTZ,
  scheduled_at      TIMESTAMPTZ,
  executed_at       TIMESTAMPTZ,
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  dedupe_key        TEXT,
  template_id       UUID,
  send_mode         TEXT NOT NULL DEFAULT 'individual'
                      CHECK (send_mode IN ('individual','bulk')),
  condition_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  result            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Executor's hot path (parity: idx_seq_steps_due). Due-step query is
-- `WHERE status IN (...) AND next_run_at <= now() ORDER BY next_run_at`.
CREATE INDEX IF NOT EXISTS sequence_execution_step_due_idx
  ON sequence.execution_step (status, next_run_at)
  WHERE status IN ('pending','scheduled','deferred');
CREATE INDEX IF NOT EXISTS sequence_execution_step_enrollment_idx
  ON sequence.execution_step (tenant_id, enrollment_id);
-- "Is this persona already enrolled in this sequence?" — supports enrollment
-- idempotency (TK-3613); persona-keyed per the identity spine.
CREATE INDEX IF NOT EXISTS sequence_execution_step_subject_idx
  ON sequence.execution_step (tenant_id, sequence_id, subject_persona_id, status);
-- Idempotent enqueue (TK-3614): the same logical send is never queued twice.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_execution_step_dedupe_idx
  ON sequence.execution_step (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------- sequence.trigger
-- Event-based enrollment rule (parity: stage_sequence_triggers, generalized).
-- Supports form-submit / reply / stage-change enrollment (TK-3613).
CREATE TABLE IF NOT EXISTS sequence.trigger (
  trigger_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  sequence_id    UUID NOT NULL REFERENCES sequence.sequence(sequence_id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL DEFAULT 'stage_change'
                   CHECK (event_type IN ('form_submit','reply','stage_change','manual','booking','tag_added')),
  stage_id       UUID,
  trigger_on     TEXT NOT NULL DEFAULT 'enter'
                   CHECK (trigger_on IN ('enter','exit')),
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sequence_trigger_event_idx
  ON sequence.trigger (tenant_id, event_type) WHERE enabled;
CREATE INDEX IF NOT EXISTS sequence_trigger_sequence_idx
  ON sequence.trigger (sequence_id);
-- One rule per (sequence, event, stage, edge) — parity with the source's
-- stage_sequence_triggers_stage_id_sequence_id_trigger_on_key.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_trigger_unique_idx
  ON sequence.trigger (sequence_id, event_type,
                       COALESCE(stage_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       trigger_on);

COMMENT ON SCHEMA sequence IS 'sdk-sequence · P14·E1 multi-touch cadence engine. Re-homed from projex_crm outreach_*, tenant-scoped, prospects-coupling dropped.';
COMMENT ON TABLE sequence.sequence       IS 'Cadence definition (parity: outreach_sequences). One per (tenant, type) may be default.';
COMMENT ON TABLE sequence.step           IS 'Ordered step definition — normalized from outreach_sequences.steps JSONB.';
COMMENT ON TABLE sequence.template       IS 'Reusable channel message body (parity: outreach_templates).';
COMMENT ON TABLE sequence.execution_step IS 'Runtime execution state (parity: sequence_execution_steps). Polled by the step executor via (status,next_run_at).';
COMMENT ON TABLE sequence.trigger        IS 'Event-based enrollment rule (parity: stage_sequence_triggers, generalized to form_submit/reply/stage_change).';
