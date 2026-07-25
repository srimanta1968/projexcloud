-- PER-DEF fixture (MUST-49): resets two webhook.delivery rows to 'dlq' status
-- immediately before each DLQ-replay test, so the tests pass on EVERY run — not
-- just the first. Attached via setupScript on both replay defs (testability
-- semi-auto):
--   POST /admin/webhooks/dlq/:delivery_id/replay        -> dlq_delivery_id   (...d1000)
--   POST /api/webhooks/deliveries/:delivery_id/replay   -> dlq_delivery_id_2 (...d1001)
-- replayDelivery (packages/sdk-webhook/src/services/dlqReplay.ts) requires
-- status='dlq' and flips dlq->pending on success, so a once-per-session GLOBAL
-- seed goes stale after the first run (rows left 'pending'). Running it per-def
-- (ON CONFLICT forces status back to 'dlq') makes it order-independent and
-- re-run-safe. It is a per-def script (not global) BECAUSE it references
-- {{cache:auth.signup-tenant.response.data.tenant_id}} — the runner defers any
-- {{cache}}-bearing setup script to the per-def semi-auto pass, which is exactly
-- when we want the reset to run. dlq deliveries have NO create API (only the
-- retry worker mints them), so this stays SQL (BUCKET C). INSERT/UPSERT-only.
-- Schema per packages/sdk-webhook/src/db/migrations/001_init_webhook.sql.

-- webhook.endpoint (parent): tenant_id scoped to the run's tenant (also what makes
-- this a per-def script). tenant is irrelevant to replay (no tenant filter) — it
-- just anchors the FK chain. url CHECK requires https://.
INSERT INTO webhook.endpoint (endpoint_id, tenant_id, url, signing_key_ref)
SELECT '00000000-0000-0000-0000-0000000d1e00'::uuid,
       '{{cache:auth.signup-tenant.response.data.tenant_id}}'::uuid,
       'https://qa-dlq-sink.example.com/hook',
       'vault:qa-dlq-signing-key'
WHERE NOT EXISTS (
  SELECT 1 FROM webhook.endpoint WHERE endpoint_id = '00000000-0000-0000-0000-0000000d1e00'
);

-- webhook.subscription (parent)
INSERT INTO webhook.subscription (subscription_id, endpoint_id, event_type)
SELECT '00000000-0000-0000-0000-0000000d1500'::uuid,
       '00000000-0000-0000-0000-0000000d1e00'::uuid,
       'qa.smoke.event'
WHERE NOT EXISTS (
  SELECT 1 FROM webhook.subscription WHERE subscription_id = '00000000-0000-0000-0000-0000000d1500'
);

-- The two DLQ deliveries, forced to 'dlq' each run. dlq_until 30 days out so
-- replayDelivery does not raise DlqWindowExpiredError (409).
INSERT INTO webhook.delivery
       (delivery_id, subscription_id, event_id, payload, status, attempts, dlq_until)
VALUES
  ('00000000-0000-0000-0000-0000000d1000'::uuid,
   '00000000-0000-0000-0000-0000000d1500'::uuid,
   'qa-dlq-event-0001', '{"probe":true}'::jsonb, 'dlq', 5, now() + interval '30 days'),
  ('00000000-0000-0000-0000-0000000d1001'::uuid,
   '00000000-0000-0000-0000-0000000d1500'::uuid,
   'qa-dlq-event-0002', '{"probe":true}'::jsonb, 'dlq', 5, now() + interval '30 days')
ON CONFLICT (delivery_id) DO UPDATE
  SET status = 'dlq', attempts = 5, dlq_until = now() + interval '30 days';
