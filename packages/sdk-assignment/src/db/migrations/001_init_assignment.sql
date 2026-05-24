-- Migration 001: sdk-assignment canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §6.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).

CREATE SCHEMA IF NOT EXISTS assignment;

-- ---------------------------------------------------------------------------
-- assignment.assignment — one row per (task, persona) proposal. Status moves
-- proposed → accepted/rejected → completed. Dispatch reads accepted rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment.assignment (
  assignment_id  TEXT PRIMARY KEY,
  -- Logical FK to dispatch.task.
  task_id        TEXT NOT NULL,
  persona_id     UUID NOT NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed','accepted','rejected','completed')
  )
);

CREATE INDEX IF NOT EXISTS assignment_task_idx     ON assignment.assignment (task_id, status);
CREATE INDEX IF NOT EXISTS assignment_persona_idx  ON assignment.assignment (persona_id, status, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- assignment.territory — geofenced primary/backup persona pools.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment.territory (
  territory_id          TEXT PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  name                  TEXT NOT NULL,
  geom                  JSONB NOT NULL,
  primary_persona_ids   TEXT[] NOT NULL DEFAULT '{}',
  backup_persona_ids    TEXT[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assignment_territory_tenant_idx ON assignment.territory (tenant_id);

-- ---------------------------------------------------------------------------
-- assignment.workload — per-persona capacity + skill profile. open_tasks is
-- updated transactionally by the dispatcher to enforce capacity_per_day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment.workload (
  persona_id        UUID PRIMARY KEY,
  open_tasks        INTEGER NOT NULL DEFAULT 0 CHECK (open_tasks >= 0),
  capacity_per_day  INTEGER NOT NULL DEFAULT 8 CHECK (capacity_per_day >= 0),
  skills            TEXT[] NOT NULL DEFAULT '{}',
  available_from    TIMESTAMPTZ,
  available_to      TIMESTAMPTZ
);

COMMENT ON SCHEMA assignment IS 'sdk-assignment (P7 §5.3). Auto-assign by radius/skill/availability + territory rules + workload balancing.';
