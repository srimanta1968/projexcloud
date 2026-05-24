-- Migration 001: sdk-sovereign canonical schema per
-- docs/v3.1/datamodel/P8-Deployment-Variants-DataModel.html §4.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Variant B · Sovereign Cloud. Isolated region with no data, telemetry,
-- audit, or control-plane signal leaving. Operated by in-region partner;
-- Projexlight ships signed bundles + Terraform/Helm.

CREATE SCHEMA IF NOT EXISTS sovereign;

-- ---------------------------------------------------------------------------
-- sovereign.region_config — declarative config per sovereign region.
-- region_id is the stable identifier (also referenced by routing.pool when
-- a pool resides in this region).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sovereign.region_config (
  region_id              TEXT PRIMARY KEY,
  regime                 TEXT NOT NULL CHECK (
    regime IN ('fedramp-high','il5','pipl','eu-sovereign','uae-trd')
  ),
  operator_partner       TEXT NOT NULL,
  -- When true, Pool Router federation manifest treats this region as terminal.
  terminal_federation    BOOLEAN NOT NULL DEFAULT TRUE,
  kms_provider           TEXT NOT NULL,
  activated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  attestation_state      TEXT NOT NULL DEFAULT 'in-progress' CHECK (
    attestation_state IN ('in-progress','attested','expired')
  )
);

CREATE INDEX IF NOT EXISTS sovereign_region_regime_idx
  ON sovereign.region_config (regime, attestation_state);

-- ---------------------------------------------------------------------------
-- sovereign.bundle_release — quarterly signed-bundle releases shipped to partner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sovereign.bundle_release (
  release_id              TEXT PRIMARY KEY,
  region_id               TEXT NOT NULL REFERENCES sovereign.region_config(region_id) ON DELETE CASCADE,
  version                 TEXT NOT NULL,
  bundle_artifact_ref     TEXT NOT NULL,
  signature               BYTEA NOT NULL,
  shipped_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at              TIMESTAMPTZ,
  rollback_to_release_id  TEXT REFERENCES sovereign.bundle_release(release_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS sovereign_bundle_region_idx
  ON sovereign.bundle_release (region_id, shipped_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sovereign_bundle_region_version_uq
  ON sovereign.bundle_release (region_id, version);

-- ---------------------------------------------------------------------------
-- sovereign.attestation — per-region attestation records (SOC2 + FedRAMP /
-- PIPL / EU sovereign, each separately).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sovereign.attestation (
  attestation_id  TEXT PRIMARY KEY,
  region_id       TEXT NOT NULL REFERENCES sovereign.region_config(region_id) ON DELETE CASCADE,
  regime          TEXT NOT NULL CHECK (
    regime IN ('fedramp-high','il5','pipl','eu-sovereign','uae-trd')
  ),
  auditor_id      TEXT NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  artifact_ref    TEXT NOT NULL,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS sovereign_attestation_region_idx
  ON sovereign.attestation (region_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- sovereign.leak_monitor_alert — continuous DPI / network-policy alerts.
-- Critical alerts page ops; warn alerts dashboarded; info logged only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sovereign.leak_monitor_alert (
  alert_id      TEXT PRIMARY KEY,
  region_id     TEXT NOT NULL REFERENCES sovereign.region_config(region_id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (
    kind IN ('egress-attempt','cross-region-route','policy-violation')
  ),
  severity      TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  incident_ref  TEXT
);

CREATE INDEX IF NOT EXISTS sovereign_leak_region_idx
  ON sovereign.leak_monitor_alert (region_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS sovereign_leak_open_idx
  ON sovereign.leak_monitor_alert (region_id, severity)
  WHERE resolved_at IS NULL;

COMMENT ON SCHEMA sovereign IS 'sdk-sovereign (P8 Variant B). Region config + signed bundles + attestation records + leak monitor alerts.';
