-- Migration 001: sdk-webhook canonical schema per P4-Operational-Billing-DataModel §10.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: webhook.{endpoint, subscription, delivery, delivery_attempt}
-- Pool: Per-pool outbox + Admin (registry)
-- FR-WHK-1..8 per PRD §5.7.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS webhook;

-- webhook.endpoint per §10.1
-- signing_key_ref FK to vault.key (loose, since vault.key.key_id is text);
-- HMAC signing key never leaves the vault, only referenced.
-- status 'circuit-open' is FR-WHK-5 circuit breaker tripping.
CREATE TABLE IF NOT EXISTS webhook.endpoint (
  endpoint_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  url                    TEXT NOT NULL,
  signing_key_ref        TEXT NOT NULL,
  signing_algo           TEXT NOT NULL DEFAULT 'hmac-sha256'
                           CHECK (signing_algo IN ('hmac-sha256','hmac-sha512')),
  mtls_client_cert_ref   TEXT,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','paused','circuit-open')),
  failure_streak         INTEGER NOT NULL DEFAULT 0,
  last_success_at        TIMESTAMPTZ,
  last_failure_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defensive: enforce HTTPS at the schema layer so a misconfigured tenant
-- cannot accidentally register an http:// endpoint that would leak HMAC.
ALTER TABLE webhook.endpoint
  DROP CONSTRAINT IF EXISTS endpoint_url_https_only;
ALTER TABLE webhook.endpoint
  ADD CONSTRAINT endpoint_url_https_only CHECK (url LIKE 'https://%');

CREATE INDEX IF NOT EXISTS endpoint_tenant_idx
  ON webhook.endpoint (tenant_id, status);

-- webhook.subscription per §10.1 - endpoint × event_type with optional jsonb filter.
-- Subscription writer validates event_type ∈ EVENT_TYPE_REGISTRY at INSERT
-- time (OC-2 producer-side mirror); no DB-level CHECK because the registry
-- lives in TypeScript.
CREATE TABLE IF NOT EXISTS webhook.subscription (
  subscription_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id         UUID NOT NULL REFERENCES webhook.endpoint(endpoint_id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  filter_predicate    JSONB,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sub_endpoint_event_uniq
  ON webhook.subscription (endpoint_id, event_type);
CREATE INDEX IF NOT EXISTS sub_event_active_idx
  ON webhook.subscription (event_type) WHERE active = TRUE;

-- webhook.delivery per §10.1 - per-pool outbox row per (subscription, event_id).
-- event_id is the source-event idempotency key; UNIQUE per subscription
-- prevents duplicate enqueue if a producer re-publishes the same event.
CREATE TABLE IF NOT EXISTS webhook.delivery (
  delivery_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    UUID NOT NULL REFERENCES webhook.subscription(subscription_id) ON DELETE CASCADE,
  event_id           TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','delivering','succeeded','failed','dlq')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at    TIMESTAMPTZ,
  dlq_until          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_sub_event_uniq
  ON webhook.delivery (subscription_id, event_id);
CREATE INDEX IF NOT EXISTS delivery_pending_due_idx
  ON webhook.delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS delivery_dlq_idx
  ON webhook.delivery (dlq_until) WHERE status = 'dlq';

-- webhook.delivery_attempt per §10.1 - one row per HTTP attempt.
-- response_excerpt is capped at 1KB at write time.
CREATE TABLE IF NOT EXISTS webhook.delivery_attempt (
  attempt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id         UUID NOT NULL REFERENCES webhook.delivery(delivery_id) ON DELETE CASCADE,
  http_status         INTEGER,
  response_excerpt    TEXT,
  latency_ms          INTEGER,
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attempt_delivery_idx
  ON webhook.delivery_attempt (delivery_id, attempted_at DESC);

COMMENT ON TABLE webhook.endpoint         IS 'Per P4-DataModel §10.1. signing_key_ref refs vault.key (never embedded). status circuit-open per FR-WHK-5.';
COMMENT ON TABLE webhook.subscription     IS 'Per §10.1. event_type validated against EVENT_TYPE_REGISTRY at write time (OC-2 mirror).';
COMMENT ON TABLE webhook.delivery         IS 'Per §10.1. (subscription, event_id) UNIQUE for idempotency; partial idx on status=pending for worker pull.';
COMMENT ON TABLE webhook.delivery_attempt IS 'Per §10.1. One row per HTTP try; response_excerpt capped at 1KB application-side.';
