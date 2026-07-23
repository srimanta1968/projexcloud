-- Migration 001: sdk-scheduling — calendar, booking & availability engine.
-- P14 · E2 (TK-3618). Auto-applied by the migration runner at boot.
--
-- Parity with projex_crm calendar.service (calendar_appointments + business-hours
-- availability slotting) — RE-HOMED as a reusable SDK, tenant-scoped, and keyed on
-- the ProjexCloud identity spine: the single-tenant `user_id` calendar owner becomes
-- an L4 `host_persona_id`, and the invitee/lead becomes an optional
-- `subject_persona_id` (matching sdk-sequence.execution_step.subject_persona_id and
-- sdk-campaign.journey_run — any lead/contact/deal resolves to its persona).
--
-- The projex_crm ad-hoc `ensureCalendarTables()` DDL-on-import is replaced by this
-- ordered, idempotent, boot-time migration (MUST-50). Business hours (per-weekday,
-- IANA tz) and reusable meeting types (15/30/45/60 min) are first-class tables.
--
-- Coupling dropped: no cross-SDK hard FKs to a persona/lead table (persona lives in
-- another schema/SDK) — host_persona_id / subject_persona_id are loose UUIDs, as in
-- sdk-sequence. This keeps the migration self-contained and order-independent.
--
-- Booking lifecycle / ICS (TK-3624), public booking routes (TK-3623), reminders &
-- no-show (TK-3625) and two-way provider sync (TK-3626) build ON these tables.
--
-- Idempotent + re-runnable: every object uses IF NOT EXISTS. A companion rollback
-- lives in ../down/001_init_scheduling.down.sql (not auto-applied — forward-only).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS scheduling;

-- ------------------------------------------------------------ scheduling.meeting_type
-- Reusable meeting definition: name + duration (15/30/45/60 min are the common
-- presets) + booking buffers. Referenced by availability slotting, appointments and
-- scheduling links so a host offers a fixed menu of bookable meeting kinds.
CREATE TABLE IF NOT EXISTS scheduling.meeting_type (
  meeting_type_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  host_persona_id  UUID,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  description      TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  location_type    TEXT NOT NULL DEFAULT 'video'
                     CHECK (location_type IN ('video','phone','in_person','custom')),
  location_detail  TEXT,
  color            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Slug is the stable, human-friendly handle used in booking URLs — unique per tenant.
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS scheduling_meeting_type_tenant_idx
  ON scheduling.meeting_type (tenant_id, is_active);

-- --------------------------------------------------------- scheduling.availability_rule
-- Per-weekday business hours for a host, in an IANA timezone. Slot generation reads
-- these to bound the bookable window; a weekday with no active rule is treated as a
-- closed day (zero slots), matching calendar.service's businessHours[day] === null.
CREATE TABLE IF NOT EXISTS scheduling.availability_rule (
  rule_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  host_persona_id  UUID NOT NULL,
  -- 0 = Sunday .. 6 = Saturday (JS Date#getDay parity).
  weekday          SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time       TIME NOT NULL DEFAULT '09:00',
  end_time         TIME NOT NULL DEFAULT '17:00',
  -- IANA timezone the start/end wall-clock times are expressed in (e.g. America/New_York).
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  slot_interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_interval_minutes > 0),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- One rule per (host, weekday) — re-setting hours upserts.
  UNIQUE (tenant_id, host_persona_id, weekday)
);

CREATE INDEX IF NOT EXISTS scheduling_availability_rule_host_idx
  ON scheduling.availability_rule (tenant_id, host_persona_id) WHERE is_active;

-- --------------------------------------------------------------- scheduling.appointment
-- A booked calendar slot (parity: calendar_appointments). Double-booking is prevented
-- at write time by an overlap check on (host_persona_id, [start,end)) for non-cancelled
-- rows. subject_persona_id is the invitee/lead persona (optional for host-blocked time).
CREATE TABLE IF NOT EXISTS scheduling.appointment (
  appointment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  host_persona_id  UUID NOT NULL,
  subject_persona_id UUID,
  meeting_type_id  UUID REFERENCES scheduling.meeting_type(meeting_type_id) ON DELETE SET NULL,
  scheduling_link_id UUID,
  title            TEXT NOT NULL,
  description      TEXT,
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  status           TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  location_type    TEXT NOT NULL DEFAULT 'video'
                     CHECK (location_type IN ('video','phone','in_person','custom')),
  location_detail  TEXT,
  meeting_url      TEXT,
  attendees        JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes            TEXT,
  -- Loose reference to the originating domain entity (lead/deal), resolved via projection.
  entity_ref       TEXT,
  source           TEXT NOT NULL DEFAULT 'internal'
                     CHECK (source IN ('internal','public_link','sequence','import','provider_sync')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

-- Overlap / availability hot path: "which appointments does this host have in
-- [start,end)?" — drives both double-book prevention and slot marking.
CREATE INDEX IF NOT EXISTS scheduling_appointment_host_window_idx
  ON scheduling.appointment (tenant_id, host_persona_id, start_time, end_time)
  WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS scheduling_appointment_subject_idx
  ON scheduling.appointment (tenant_id, subject_persona_id) WHERE subject_persona_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduling_appointment_status_idx
  ON scheduling.appointment (tenant_id, status, start_time);

-- ----------------------------------------------------------- scheduling.scheduling_link
-- A shareable public booking link (Calendly-style): binds a host + meeting type to a
-- stable slug so an external invitee can self-book within the host's availability. The
-- link LIFECYCLE (public booking routes, confirmation, ICS) lands with TK-3623/3624;
-- this table is created now so those tasks build on a stable schema (task scope: "add
-- scheduling schema (appointments, scheduling_links)").
CREATE TABLE IF NOT EXISTS scheduling.scheduling_link (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  host_persona_id  UUID NOT NULL,
  meeting_type_id  UUID REFERENCES scheduling.meeting_type(meeting_type_id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  title            TEXT,
  description      TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  max_days_ahead   INTEGER NOT NULL DEFAULT 30 CHECK (max_days_ahead > 0),
  min_notice_minutes INTEGER NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  expires_at       TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Public slug is globally unique so it can key a public /book/:slug route.
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS scheduling_link_host_idx
  ON scheduling.scheduling_link (tenant_id, host_persona_id) WHERE is_active;

COMMENT ON SCHEMA scheduling IS 'sdk-scheduling · P14·E2 calendar/booking engine. Re-homed from projex_crm calendar.service, tenant-scoped, persona-keyed.';
COMMENT ON TABLE scheduling.meeting_type      IS 'Reusable bookable meeting kind (name + duration + buffers). Common durations: 15/30/45/60 min.';
COMMENT ON TABLE scheduling.availability_rule IS 'Per-weekday business hours for a host in an IANA timezone. No active rule for a weekday = closed day.';
COMMENT ON TABLE scheduling.appointment       IS 'Booked calendar slot (parity: calendar_appointments). Overlap-guarded per host for double-book prevention.';
COMMENT ON TABLE scheduling.scheduling_link   IS 'Shareable public booking link (host + meeting type + slug). Lifecycle lands with TK-3623/3624.';
