-- Migration 004: sdk-meter hard-cap (DENY) mode activates in P7.
-- Per docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §12 and
-- PRD §12 ("Meter Hard Caps — mode flip"). Reserved usage.hardcap.
-- exceeded.v1 event type was registered in P1; this migration adds the
-- denial row backing it. Auto-applied by @projexlight/migration-runner.
--
-- Behavior change: when env METER_MODE=hard-cap the gate returns 429
-- QuotaExceeded instead of stamping a soft-cap WARN header. Latency
-- budget remains ≤ 2ms per PRD §6.
--
-- Rollout (R-1 mitigation): default stays soft-cap. Flip to hard-cap is
-- an operator action after 30+ weeks of soft-cap calibration data and
-- a canary tenant cohort.

CREATE TABLE IF NOT EXISTS meter.quota_denial (
  denial_id                TEXT PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  sku                      TEXT NOT NULL,
  -- Logical FK to meter.quota_policy.
  policy_id                TEXT NOT NULL,
  denied_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count_24h        INTEGER NOT NULL DEFAULT 0 CHECK (request_count_24h >= 0),
  operator_override_until  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS meter_quota_denial_tenant_idx
  ON meter.quota_denial (tenant_id, denied_at DESC);
CREATE INDEX IF NOT EXISTS meter_quota_denial_sku_idx
  ON meter.quota_denial (sku, denied_at DESC);
CREATE INDEX IF NOT EXISTS meter_quota_denial_override_idx
  ON meter.quota_denial (operator_override_until)
  WHERE operator_override_until IS NOT NULL;

COMMENT ON TABLE meter.quota_denial IS 'P7 §12 — hard-cap (DENY) denials. Powers tenant-admin triage + usage.hardcap.exceeded.v1 events.';
