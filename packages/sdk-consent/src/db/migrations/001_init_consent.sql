-- Migration 001: sdk-consent canonical schema per P2-Identity-Access-DataModel §6.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup
-- (services/api-gateway/src/app.ts -> runMigrations). Forward-only; SHA-tracked.
--
-- Tables: consent.{purpose, receipt, revocation, offline_grant_queue}
-- Pool placement: Admin (person home region) per PRD §5.3.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS consent;

-- consent.purpose -- typed purpose registry per app (FR-CNS-4)
CREATE TABLE IF NOT EXISTS consent.purpose (
  purpose_id            TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL,
  description           TEXT NOT NULL,
  legal_basis           TEXT NOT NULL
                          CHECK (legal_basis IN ('consent','contract','legitimate-interest','vital','public-task','legal-obligation')),
  default_jurisdictions TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purpose_app_idx ON consent.purpose (app_id);

-- consent.receipt -- one row per consent grant (FR-CNS-1, FR-CNS-6)
CREATE TABLE IF NOT EXISTS consent.receipt (
  receipt_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id               UUID NOT NULL,
  purpose_id              TEXT NOT NULL REFERENCES consent.purpose(purpose_id) ON DELETE RESTRICT,
  processor               TEXT NOT NULL,
  app_id                  TEXT NOT NULL,
  jurisdiction            TEXT NOT NULL,
  granted_by_actor        TEXT NOT NULL,
  granted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ,
  source_tenant_id        UUID,
  target_tenant_id        UUID,
  revoked_at              TIMESTAMPTZ,
  revocation_id           UUID,
  evidence_hash           BYTEA NOT NULL,
  UNIQUE (person_id, purpose_id, processor, app_id, jurisdiction)
);

CREATE INDEX IF NOT EXISTS receipt_person_idx       ON consent.receipt (person_id);
CREATE INDEX IF NOT EXISTS receipt_purpose_idx      ON consent.receipt (purpose_id);
CREATE INDEX IF NOT EXISTS receipt_cross_tenant_idx ON consent.receipt (source_tenant_id, target_tenant_id)
  WHERE source_tenant_id IS NOT NULL OR target_tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipt_active_idx       ON consent.receipt (person_id, purpose_id) WHERE revoked_at IS NULL;

-- consent.revocation -- append-only revocation log (FR-CNS-2)
CREATE TABLE IF NOT EXISTS consent.revocation (
  revocation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id      UUID NOT NULL REFERENCES consent.receipt(receipt_id) ON DELETE RESTRICT,
  revoked_by      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revocation_receipt_idx ON consent.revocation (receipt_id);

-- consent.offline_grant_queue -- receipts captured offline by HDK (FR-CNS-3, replayed in P3)
CREATE TABLE IF NOT EXISTS consent.offline_grant_queue (
  queued_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL,
  purpose_id     TEXT NOT NULL REFERENCES consent.purpose(purpose_id) ON DELETE RESTRICT,
  processor      TEXT NOT NULL,
  app_id         TEXT NOT NULL,
  jurisdiction   TEXT NOT NULL,
  device_uuid    TEXT NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL,
  replayed_at    TIMESTAMPTZ,
  replay_status  TEXT NOT NULL DEFAULT 'pending'
                   CHECK (replay_status IN ('pending','replayed','failed'))
);

CREATE INDEX IF NOT EXISTS offline_queue_pending_idx ON consent.offline_grant_queue (replay_status, captured_at)
  WHERE replay_status = 'pending';
