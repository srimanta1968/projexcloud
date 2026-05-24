-- Migration 001: sdk-dispatch canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §5.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).

CREATE SCHEMA IF NOT EXISTS dispatch;

-- ---------------------------------------------------------------------------
-- dispatch.queue — per-tenant queue with a typed policy bag (priority,
-- territory rules, skill rules). One queue can hold tasks across encounters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch.queue (
  queue_id      TEXT PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  name          TEXT NOT NULL,
  policy        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','paused','archived')
  ),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_queue_tenant_idx ON dispatch.queue (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_queue_tenant_name_uq ON dispatch.queue (tenant_id, name);

-- ---------------------------------------------------------------------------
-- dispatch.task — a unit of work bound to an encounter and a service address.
-- Work units are encounters (FR-DSP-1: engagement-aware queue).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch.task (
  task_id        TEXT PRIMARY KEY,
  queue_id       TEXT NOT NULL REFERENCES dispatch.queue(queue_id) ON DELETE CASCADE,
  -- Logical FK to engagement.encounter (no hard FK across schemas at MVP).
  -- Type matches engagement.encounter.encounter_id (UUID).
  encounter_id   UUID NOT NULL,
  -- Logical FK to geo.address.
  address_id     TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 100,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','assigned','in-progress','completed','cancelled')
  ),
  scheduled_for  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_task_queue_status_idx
  ON dispatch.task (queue_id, status, priority DESC, scheduled_for);
CREATE INDEX IF NOT EXISTS dispatch_task_encounter_idx
  ON dispatch.task (encounter_id);

-- ---------------------------------------------------------------------------
-- dispatch.route — optimized stop sequence for one dispatcher persona.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch.route (
  route_id          TEXT PRIMARY KEY,
  persona_id        UUID NOT NULL,
  -- Ordered list of task_ids stored as a typed JSONB array for replay.
  stops             JSONB NOT NULL DEFAULT '[]'::jsonb,
  optimized_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_drive_mins  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS dispatch_route_persona_idx ON dispatch.route (persona_id, optimized_at DESC);

COMMENT ON SCHEMA dispatch IS 'sdk-dispatch (P7 §5.2). Unified queue + route optimization + per-tenant policy.';
