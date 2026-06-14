-- Migration 002 (P10/E1): obligation-based authorization.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- ADDITIVE ONLY (E7 non-breaking invariant): adds an optional obligations
-- column to the policy bundle (the declared source of obligations) and to the
-- decision log (so policy observability can replay mask/filter/audit/ttl per
-- decision). No drops, renames, or NOT NULL additions — pre-P10 rows and
-- allow/deny-only callers are unaffected.

-- Obligations a policy attaches to an ALLOW decision:
--   { "mask_fields": [...], "row_filter": {...}, "audit_level": "...", "ttl_seconds": N }
ALTER TABLE policy.policy   ADD COLUMN IF NOT EXISTS obligations JSONB;

-- Obligations actually emitted on a sampled decision (NULL for pre-P10 rows
-- and for DENY / obligation-free decisions).
ALTER TABLE policy.decision ADD COLUMN IF NOT EXISTS obligations JSONB;
