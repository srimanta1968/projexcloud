-- Migration 002 (P10/E3): healthcare purpose taxonomy (HIPAA TPO + 42 CFR Part 2).
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- ADDITIVE ONLY: tags each purpose with a category and a `segmented` flag.
-- `segmented` marks 42 CFR Part 2 substance-use purposes that require a
-- dedicated consent distinct from general PHI/TPO consent. Existing rows
-- default to category 'general', segmented false — no behaviour change.

ALTER TABLE consent.purpose
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'hipaa_tpo', 'part2_substance_use'));

ALTER TABLE consent.purpose
  ADD COLUMN IF NOT EXISTS segmented BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS purpose_category_idx ON consent.purpose (app_id, category);
