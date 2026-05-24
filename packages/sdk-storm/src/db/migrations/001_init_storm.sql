-- Migration 001: sdk-storm canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §4.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).

CREATE SCHEMA IF NOT EXISTS storm;

-- ---------------------------------------------------------------------------
-- storm.event — a discrete weather event (hurricane, hail swarm, …) ingested
-- from a provider feed. Multi-provider fallback per PRD R-7 mitigation:
-- (provider, provider_event_id) is unique so two providers can each describe
-- the same physical storm without collision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storm.event (
  event_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (
    kind IN ('hurricane','tornado','hail','flood','wildfire','winter')
  ),
  provider            TEXT NOT NULL CHECK (
    provider IN ('noaa','dtn','weather-underground')
  ),
  provider_event_id   TEXT NOT NULL,
  -- Coverage area as GeoJSON; PostGIS optional in MVP (see sdk-geo doctrine).
  geom                JSONB NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  severity            TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS storm_event_provider_uq
  ON storm.event (provider, provider_event_id);
CREATE INDEX IF NOT EXISTS storm_event_kind_started_idx
  ON storm.event (kind, started_at DESC);

-- ---------------------------------------------------------------------------
-- storm.intensity_cell — gridded measurements within an event footprint.
-- Per-bbox queries (sdk-storm SKU storm.overlay.query) fan over this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storm.intensity_cell (
  cell_id        TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES storm.event(event_id) ON DELETE CASCADE,
  cell_geom      JSONB NOT NULL,
  wind_mph       NUMERIC,
  hail_in        NUMERIC,
  rainfall_in    NUMERIC,
  gust_mph       NUMERIC,
  captured_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS storm_intensity_event_idx
  ON storm.intensity_cell (event_id, captured_at DESC);

COMMENT ON SCHEMA storm IS 'sdk-storm (P7 §5.1). Storm event registry + per-bbox intensity grids ingested from weather APIs.';
