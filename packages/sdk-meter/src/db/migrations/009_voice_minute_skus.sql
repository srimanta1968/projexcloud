-- Migration 009: AI voice minutes (VA·E7 · TK-4503). Forward-only; sha256-tracked.
-- All statements idempotent.
--
-- (1) The voice SKU rate card: voice.minute.inbound / voice.minute.outbound, priced per
--     minute (sample platform-fee defaults — production rates land via the catalog-versioning
--     admin workflow, same caveat as 005/008). Provider spend is the tenant's own (BYOK) and
--     is never on this invoice; these SKUs are the platform's per-minute fee.
-- (2) meter.voice_call_meter: one row per metered call. The primary key makes metering
--     idempotent (a call is billed once, however often "ended" fires) and the rows are the
--     queryable per-call record: raw duration, billable seconds rounded UP to 6-second
--     blocks, and minutes. Test sessions are never written here.

INSERT INTO meter.pricing_catalog (catalog_id, version, status, effective_from, created_by)
VALUES ('platform-voice-2026q4', 1, 'active', now(), 'migration:009_voice_minute_skus')
ON CONFLICT (catalog_id) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-voice-2026q4', 'voice.minute.inbound',  'minute', 'per_unit', 0.03),
  ('platform-voice-2026q4', 'voice.minute.outbound', 'minute', 'per_unit', 0.04)
ON CONFLICT (catalog_id, sku) DO NOTHING;

CREATE TABLE IF NOT EXISTS meter.voice_call_meter (
  call_id           uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  agent_id          uuid,
  sku               text NOT NULL CHECK (sku IN ('voice.minute.inbound','voice.minute.outbound')),
  duration_s        integer NOT NULL CHECK (duration_s >= 0),
  billable_seconds  integer NOT NULL CHECK (billable_seconds >= 0 AND billable_seconds % 6 = 0),
  minutes           numeric(12,1) NOT NULL CHECK (minutes >= 0),
  ended_at          timestamptz NOT NULL,
  metered_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meter_voice_call_tenant_idx ON meter.voice_call_meter (tenant_id, ended_at DESC);
