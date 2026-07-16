-- Rollback for 002_crm_funnel_stages.sql (TK-3628).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent. Drops ONLY what 002 added — the crm schema and crm.deal itself
-- (from 001) are left intact.

ALTER TABLE crm.deal DROP COLUMN IF EXISTS last_stage_change_at;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS entered_stage_at;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS forecast;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS offer_version;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS decision_date;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS stakeholders;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS outcome;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS impact;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS pain;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS fit;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS priority;
ALTER TABLE crm.deal DROP COLUMN IF EXISTS funnel_stage_id;

DROP TABLE IF EXISTS crm.funnel_stage CASCADE;
