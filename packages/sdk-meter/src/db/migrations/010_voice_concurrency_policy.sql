-- Migration 010: plan concurrent-call cap (VA·E7 · TK-4504). Forward-only; sha256-tracked.
-- All statements idempotent.
--
-- The plan's concurrent AI-call entitlement is a meter.quota_policy row for the SKU
-- voice.concurrent_calls, the same per-tenant cap table every other SKU uses:
--   hard_cap = concurrent calls the plan allows (the dialer refuses the next call),
--   soft_cap = active calls at which the tenant is alerted (80 % of the cap by default),
--   "window" is required by the table but meaningless for a point-in-time count; 'minute'.
-- A tenant row (tenant_id = the tenant) overrides the platform default (tenant_id NULL),
-- seeded here at the dialer's historic default of 10 calls / alert at 8.

INSERT INTO meter.quota_policy (tenant_id, sku, soft_cap, hard_cap, "window", action_on_soft)
SELECT NULL, 'voice.concurrent_calls', 8, 10, 'minute', 'warn'
 WHERE NOT EXISTS (
   SELECT 1 FROM meter.quota_policy WHERE tenant_id IS NULL AND sku = 'voice.concurrent_calls'
 );
