-- Migration 002: allow the 'synthetic' provider on storm.event.
--
-- 001's provider CHECK only permitted the real feeds
-- ('noaa','dtn','weather-underground'). But the synthetic adapter
-- (services/providers.ts → SyntheticStormAdapter, provider='synthetic') is the
-- designed ingest floor: in dev/CI the real adapters report available()=false
-- (no NOAA_INGEST_ENABLED / DTN_API_KEY / WU_API_KEY), so synthetic always wins
-- the chain and the ingestor inserts provider='synthetic'. That violated
-- event_provider_check on every tick:
--   "new row for relation \"event\" violates check constraint \"event_provider_check\""
--
-- Widen the allow-list to include 'synthetic' so the dev/CI pipeline persists
-- data. Forward-only per the migration runner (001 is already applied).
ALTER TABLE storm.event DROP CONSTRAINT IF EXISTS event_provider_check;
ALTER TABLE storm.event ADD CONSTRAINT event_provider_check
  CHECK (provider IN ('noaa', 'dtn', 'weather-underground', 'synthetic'));
