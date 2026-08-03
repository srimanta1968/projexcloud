-- Migration 001: sdk-coverage — who is actually available (P16 · EP-377 · PCF-04-1).
--
--   work_schedule       — when a persona is nominally working
--   time_off            — when they are not, whatever the reason
--   holiday_calendar    — when a whole region is not, per tenant
--   presence            — what is true right now, AND WHO SAID SO
--   capacity_policy      — how much they can hold at once, per priority band
--   on_call_roster      — who answers out of hours, at which tier
--   backup_designation  — who catches it when the primary does not
--
-- Availability is a SUBTRACTION, and this schema exists to make each term of it a
-- separate, queryable fact: schedule MINUS time-off MINUS holiday, intersected with
-- live presence and capacity headroom. Collapsing any of those into a single
-- "available" boolean is what makes a routing decision unexplainable — nobody can
-- say WHY somebody was skipped, so nobody trusts the answer.
--
-- persona_id and role_ref are LOOSE references (no cross-schema FK): the persona
-- lives in sdk-persona and this package must not depend on it. Every row is
-- tenant-scoped.
--
-- Idempotent + re-runnable; rollback in ../down/001_init_coverage.down.sql.

CREATE SCHEMA IF NOT EXISTS coverage;

DO $$ BEGIN
  CREATE TYPE coverage.time_off_kind AS ENUM (
    'PTO',
    'MEETING',
    'OUTAGE',
    'HOLIDAY'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE coverage.presence_status AS ENUM (
    'AVAILABLE',
    'MEETING',
    'OFFLINE',
    'PTO',
    'ON_CALL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  /*
   * WHO SAID SO. A calendar sync and a person flipping their own toggle are
   * different claims about the same fact, and a service that cannot tell them apart
   * will let a stale calendar overwrite somebody who just said "I am here" — or the
   * reverse. Recording the source is what makes a precedence rule expressible at
   * all.
   */
  CREATE TYPE coverage.presence_source AS ENUM (
    'MANUAL',
    'CALENDAR',
    'SYSTEM'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION coverage.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/*
 * Named IANA zones only, exactly as sdk-sla's business_calendar requires.
 * A schedule stored as "+05:30" is wrong twice a year, and the failure is silent:
 * the offset keeps working, it just describes the wrong hour after a transition.
 */
CREATE OR REPLACE FUNCTION coverage.is_named_timezone(tz TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN tz IS NOT NULL
     AND tz !~ '^[+-][0-9]'
     AND tz !~ '^(UTC|GMT)[+-][0-9]'
     AND (tz = 'UTC' OR tz ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ======================================================= work_schedule
CREATE TABLE IF NOT EXISTS coverage.work_schedule (
  schedule_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  persona_id   UUID NOT NULL,
  /*
   * Per-weekday windows keyed 1=Monday..7=Sunday, matching sdk-sla:
   *   { "1": [{"start":"09:00","end":"17:00"}], "5": [...] }
   * A weekday absent from the object means not working, which is different from
   * present-but-empty; both are readable here and neither needs a special value.
   */
  weekly_windows JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The persona's OWN zone. Eligibility is evaluated in it, because "are they
  -- working at 09:00" is a question about their morning, not the server's.
  iana_timezone TEXT NOT NULL
    CONSTRAINT work_schedule_named_timezone CHECK (coverage.is_named_timezone(iana_timezone)),
  effective_from DATE,
  effective_to   DATE,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_schedule_effective_order CHECK (
    effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
  )
);

-- One ACTIVE schedule per persona: two would make "when do they work" ambiguous
-- at exactly the moment a routing decision needs one answer. Superseded schedules
-- stay, deactivated, so history is readable.
CREATE UNIQUE INDEX IF NOT EXISTS work_schedule_active_unique_idx
  ON coverage.work_schedule (tenant_id, persona_id)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS work_schedule_tenant_idx
  ON coverage.work_schedule (tenant_id, persona_id);

DROP TRIGGER IF EXISTS work_schedule_touch_trg ON coverage.work_schedule;
CREATE TRIGGER work_schedule_touch_trg
  BEFORE UPDATE ON coverage.work_schedule
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ============================================================ time_off
/*
 * Deliberately NOT mutually exclusive. A meeting inside a day of PTO, or an outage
 * overlapping both, are all true at once, and the eligibility engine takes the
 * UNION: any covering interval makes the persona unavailable. Enforcing
 * non-overlap here would force callers to merge intervals before writing them,
 * which loses the reason — and the reason is what a coverage report is for.
 */
CREATE TABLE IF NOT EXISTS coverage.time_off (
  time_off_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  persona_id   UUID NOT NULL,
  kind         coverage.time_off_kind NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  reason       TEXT,
  -- Where it came from (a calendar event id, a leave-system reference), so a
  -- re-sync can update its own rows without touching a manual entry.
  source_ref   TEXT,
  source       coverage.presence_source NOT NULL DEFAULT 'MANUAL',
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_off_interval_order CHECK (ends_at > starts_at)
);

-- The eligibility query is "does any interval cover this instant for this
-- persona", so the index leads with persona and range.
CREATE INDEX IF NOT EXISTS time_off_window_idx
  ON coverage.time_off (tenant_id, persona_id, starts_at, ends_at);
/*
 * A re-sync updates its own rows in place rather than duplicating them.
 *
 * NOT a partial index, deliberately. NULLs are distinct in a unique index by
 * default, so this already permits any number of manual rows (source_ref IS NULL)
 * while deduplicating the ones a sync owns — identical semantics to
 * `WHERE source_ref IS NOT NULL`, minus the trap: inferring a PARTIAL index in
 * ON CONFLICT requires the caller to repeat the predicate, and forgetting it fails
 * at runtime with "no unique or exclusion constraint matching the ON CONFLICT
 * specification". Verified: the plain
 * `ON CONFLICT (tenant_id, persona_id, source, source_ref)` a caller would write
 * first is the one that works.
 */
CREATE UNIQUE INDEX IF NOT EXISTS time_off_source_unique_idx
  ON coverage.time_off (tenant_id, persona_id, source, source_ref);

DROP TRIGGER IF EXISTS time_off_touch_trg ON coverage.time_off;
CREATE TRIGGER time_off_touch_trg
  BEFORE UPDATE ON coverage.time_off
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ==================================================== holiday_calendar
/*
 * Tenant AND region scoped. A public holiday is not a property of the platform or
 * even of the tenant — a tenant operating in two countries has two different
 * closed-day sets, and one shared list would either close the wrong offices or
 * open the wrong ones.
 */
CREATE TABLE IF NOT EXISTS coverage.holiday_calendar (
  holiday_calendar_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Free-form so a tenant can key by country, state, site or whatever its
  -- operating reality is. Naming the granularity here would be a business rule.
  region       TEXT NOT NULL CHECK (length(btrim(region)) > 0),
  name         TEXT,
  dates        DATE[] NOT NULL DEFAULT ARRAY[]::date[],
  -- WHO keeps it current. A holiday list nobody owns silently goes stale, and the
  -- first anyone notices is a working day that should not have been.
  maintained_by TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, region)
);

CREATE INDEX IF NOT EXISTS holiday_calendar_tenant_idx
  ON coverage.holiday_calendar (tenant_id)
  WHERE is_active;

DROP TRIGGER IF EXISTS holiday_calendar_touch_trg ON coverage.holiday_calendar;
CREATE TRIGGER holiday_calendar_touch_trg
  BEFORE UPDATE ON coverage.holiday_calendar
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ============================================================ presence
/*
 * What is true RIGHT NOW — one row per persona, upserted.
 *
 * The history of presence changes belongs in the audit chain (this package emits
 * an event per transition), not here: a table that is both current state and log
 * makes the "who is available now" query scan a growing history for no benefit.
 */
CREATE TABLE IF NOT EXISTS coverage.presence (
  presence_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  persona_id   UUID NOT NULL,
  status       coverage.presence_status NOT NULL DEFAULT 'OFFLINE',
  source       coverage.presence_source NOT NULL DEFAULT 'MANUAL',
  -- Which calendar connection or system set it, so a sync can recognise its own.
  source_ref   TEXT,
  /*
   * A MANUAL claim outranks an automated one until this instant. Somebody saying
   * "I am here" must not be overwritten two seconds later by a calendar that still
   * thinks they are in a meeting; equally, a manual toggle cannot win forever or
   * the calendar would never recover. The precedence rule is service logic, but it
   * needs somewhere to write the deadline down.
   */
  manual_hold_until TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, persona_id)
);

CREATE INDEX IF NOT EXISTS presence_available_idx
  ON coverage.presence (tenant_id, status);

DROP TRIGGER IF EXISTS presence_touch_trg ON coverage.presence;
CREATE TRIGGER presence_touch_trg
  BEFORE UPDATE ON coverage.presence
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ===================================================== capacity_policy
/*
 * How much one persona (or everyone in a role) can hold at once.
 *
 * max_concurrent_by_band is JSONB keyed by the tenant's OWN band names:
 *   { "urgent": 2, "standard": 8 }
 * Naming the bands in this schema would be a business rule, and the first vertical
 * with a third band would have to alter the platform. The service reads the map;
 * a band absent from it is uncapped, which is different from capped at zero and
 * both are expressible.
 */
CREATE TABLE IF NOT EXISTS coverage.capacity_policy (
  capacity_policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Exactly one of persona_id / role_ref: a policy that named both would leave the
  -- precedence between them undefined at the moment it matters.
  persona_id   UUID,
  role_ref     TEXT,
  max_concurrent_by_band JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Total across all bands, for the day, in the persona's own zone.
  daily_cap    INTEGER CHECK (daily_cap IS NULL OR daily_cap >= 0),
  /*
   * Fraction of a band's limit at which new assignment stops. 1.0 means "stop when
   * full"; below that, headroom is deliberately reserved. Per-band overrides live
   * in freeze_threshold_by_band.
   */
  freeze_threshold NUMERIC(4,3) NOT NULL DEFAULT 1.000
    CHECK (freeze_threshold > 0 AND freeze_threshold <= 1),
  freeze_threshold_by_band JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT capacity_policy_subject_xor CHECK (
    (persona_id IS NOT NULL AND role_ref IS NULL)
    OR (persona_id IS NULL AND role_ref IS NOT NULL)
  ),
  CONSTRAINT capacity_policy_bands_object CHECK (
    jsonb_typeof(max_concurrent_by_band) = 'object'
    AND jsonb_typeof(freeze_threshold_by_band) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS capacity_policy_persona_unique_idx
  ON coverage.capacity_policy (tenant_id, persona_id)
  WHERE persona_id IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS capacity_policy_role_unique_idx
  ON coverage.capacity_policy (tenant_id, role_ref)
  WHERE role_ref IS NOT NULL AND is_active;

DROP TRIGGER IF EXISTS capacity_policy_touch_trg ON coverage.capacity_policy;
CREATE TRIGGER capacity_policy_touch_trg
  BEFORE UPDATE ON coverage.capacity_policy
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ====================================================== on_call_roster
/*
 * Who answers, when, at which tier. Overlapping entries are legitimate — tier 1
 * and tier 2 are both on call simultaneously, which is the point of tiers — so
 * there is no exclusion constraint. What matters is that a gap is DETECTABLE, and
 * that needs the intervals kept as intervals rather than flattened.
 */
CREATE TABLE IF NOT EXISTS coverage.on_call_roster (
  roster_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Which rotation this entry belongs to. Loose string: the tenant names its own.
  rotation_ref TEXT NOT NULL CHECK (length(btrim(rotation_ref)) > 0),
  role_ref     TEXT,
  persona_id   UUID NOT NULL,
  -- 1 is first to hear. Lower answers earlier; the escalation ladder walks up.
  tier         INTEGER NOT NULL DEFAULT 1 CHECK (tier >= 1),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  is_manager_on_duty BOOLEAN NOT NULL DEFAULT false,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT on_call_roster_interval_order CHECK (ends_at > starts_at),
  -- The same persona twice on the same tier of the same rotation at the same
  -- instant is a data-entry mistake, not a redundancy.
  CONSTRAINT on_call_roster_no_exact_duplicate
    UNIQUE (tenant_id, rotation_ref, tier, persona_id, starts_at)
);

CREATE INDEX IF NOT EXISTS on_call_roster_window_idx
  ON coverage.on_call_roster (tenant_id, rotation_ref, tier, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS on_call_roster_gap_idx
  ON coverage.on_call_roster (tenant_id, rotation_ref, starts_at);

DROP TRIGGER IF EXISTS on_call_roster_touch_trg ON coverage.on_call_roster;
CREATE TRIGGER on_call_roster_touch_trg
  BEFORE UPDATE ON coverage.on_call_roster
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();

-- ================================================== backup_designation
CREATE TABLE IF NOT EXISTS coverage.backup_designation (
  designation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  primary_persona_id UUID NOT NULL,
  backup_persona_id  UUID NOT NULL,
  -- What the designation covers (a queue, a region, a rotation). Loose by design.
  scope        TEXT,
  /*
   * How long the primary has to accept before it falls to the backup. Zero would
   * mean the backup is notified simultaneously, which is a different arrangement
   * and should be said explicitly rather than arrived at by an empty field.
   */
  acceptance_window_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (acceptance_window_minutes >= 0),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A persona cannot back themselves up. The whole purpose of a backup is that it
  -- is somebody else, so a row saying otherwise is a silent single point of failure.
  CONSTRAINT backup_designation_distinct CHECK (primary_persona_id <> backup_persona_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_designation_unique_idx
  ON coverage.backup_designation (tenant_id, primary_persona_id, COALESCE(scope, ''))
  WHERE is_active;
CREATE INDEX IF NOT EXISTS backup_designation_backup_idx
  ON coverage.backup_designation (tenant_id, backup_persona_id)
  WHERE is_active;

DROP TRIGGER IF EXISTS backup_designation_touch_trg ON coverage.backup_designation;
CREATE TRIGGER backup_designation_touch_trg
  BEFORE UPDATE ON coverage.backup_designation
  FOR EACH ROW EXECUTE FUNCTION coverage.touch_updated_at();
