-- Migration 004: sdk-scheduling — two-way calendar provider sync.
-- P14 · E2 (TK-3622). Auto-applied at boot. Additive + idempotent.
--
-- Replaces the simulated sync with a real connector-backed model: a calendar_connection
-- binds a host to an external provider (Google Workspace / Microsoft 365 / CalDAV) via an
-- sdk-connectors install, and calendar_sync_map records the appointment <-> external
-- event id mapping so reschedule/cancel propagate to the right external event.

CREATE TABLE IF NOT EXISTS scheduling.calendar_connection (
  connection_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  host_persona_id     UUID NOT NULL,
  provider            TEXT NOT NULL
                        CHECK (provider IN ('google','microsoft','caldav')),
  -- sdk-connectors install that holds the OAuth grant / credentials for this provider.
  connector_install_id UUID,
  external_calendar_id TEXT,
  direction           TEXT NOT NULL DEFAULT 'both'
                        CHECK (direction IN ('inbound','outbound','both')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','error')),
  -- Opaque provider delta cursor (Google syncToken / Microsoft deltaLink).
  sync_token          TEXT,
  last_synced_at      TIMESTAMPTZ,
  last_error          TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One connection per (host, provider, external calendar).
  UNIQUE (tenant_id, host_persona_id, provider, external_calendar_id)
);

CREATE INDEX IF NOT EXISTS scheduling_calendar_connection_host_idx
  ON scheduling.calendar_connection (tenant_id, host_persona_id) WHERE status = 'active';

-- Appointment <-> external event mapping (one per connection+appointment).
CREATE TABLE IF NOT EXISTS scheduling.calendar_sync_map (
  map_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  connection_id     UUID NOT NULL REFERENCES scheduling.calendar_connection(connection_id) ON DELETE CASCADE,
  appointment_id    UUID NOT NULL REFERENCES scheduling.appointment(appointment_id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  etag              TEXT,
  -- Which side last wrote — guards against echo loops on two-way sync.
  last_direction    TEXT NOT NULL DEFAULT 'outbound'
                      CHECK (last_direction IN ('inbound','outbound')),
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, appointment_id)
);

CREATE INDEX IF NOT EXISTS scheduling_calendar_sync_map_appt_idx
  ON scheduling.calendar_sync_map (tenant_id, appointment_id);
CREATE INDEX IF NOT EXISTS scheduling_calendar_sync_map_ext_idx
  ON scheduling.calendar_sync_map (connection_id, external_event_id);

COMMENT ON TABLE scheduling.calendar_connection IS 'Host <-> external calendar provider binding (Google/Microsoft/CalDAV) via an sdk-connectors install.';
COMMENT ON TABLE scheduling.calendar_sync_map IS 'Appointment <-> external event id mapping so reschedule/cancel propagate to the right provider event.';
